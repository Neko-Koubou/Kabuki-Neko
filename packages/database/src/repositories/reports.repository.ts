import { createHash } from "node:crypto";
import type { DataSource, EntityManager } from "typeorm";
import {
  reportPlayersQuerySchema,
  reportAnswersQuerySchema,
  type Answer,
} from "@kabuki-neko/shared";
import { writeTransaction } from "../data-source.factory";
import type { FinalizationJob } from "./jobs.repository";

interface SessionRecord {
  id: string;
  host_id: string;
  quiz_id: string | null;
  quiz_title_snapshot: string;
  quiz_revision: number;
  pin_code: string;
  display_mode: "PROJECTOR" | "STREAMER";
  end_reason: "COMPLETED" | "HOST_ENDED" | "EXPIRED";
  total_players: number;
  total_questions: number;
  played_questions: number;
  started_at: number | null;
  ended_at: number;
  created_at: number;
  schema_version: 1;
  snapshot: object;
}
interface QuestionRecord {
  source_question_id: string | null;
  question_index: number;
  snapshot: object;
  status: "UNPLAYED" | "PLAYED";
  opened_at: number | null;
  closed_at: number | null;
  close_reason: string | null;
  eligible_player_ids: string[];
}
interface PlayerRecord {
  id: string;
  nickname: string;
  avatar_style: string;
  avatar_seed: string;
  join_order: number;
  is_kicked: boolean;
  final_score: number;
  final_rank: number | null;
  correct_count: number;
  unanswered_count: number;
  max_streak: number;
  avg_response_time_ms: number | null;
  joined_at: number;
  kicked_at: number | null;
}
interface AnswerRecord {
  player_id: string;
  question_id: string | null;
  question_index: number;
  submission_id: string | null;
  submitted_payload: Answer | null;
  result: string;
  is_correct: boolean | null;
  accuracy_numerator: number;
  accuracy_denominator: number;
  response_time_ms: number | null;
  received_at: number | null;
  points_awarded: number;
  streak_bonus_awarded: number;
  current_streak: number;
}
export interface ReportBatch {
  session: SessionRecord;
  questions: QuestionRecord[];
  players: PlayerRecord[];
  answers: AnswerRecord[];
}
/** RFC 4122 name-based UUID, namespaced by the immutable session ID. */
export function reportRowId(sessionId: string, name: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(sessionId))
    throw new Error("INVALID_FORMAT");
  const digest = createHash("sha1")
    .update(Buffer.from(sessionId.replaceAll("-", ""), "hex"))
    .update(name)
    .digest();
  digest[6] = ((digest[6] ?? 0) & 15) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 63) | 0x80;
  const hex = digest.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
async function sourceId(m: EntityManager, table: "quizzes" | "questions", id: string | null) {
  if (!id) return null;
  const q = m
    .createQueryBuilder(table, "source")
    .select("source.id", "id")
    .where("source.id=:id", { id });
  if (m.connection.options.type !== "better-sqlite3") q.setLock("pessimistic_read");
  return (await q.getRawOne<{ id: string }>())?.id ?? null;
}
export class ReportsRepository {
  constructor(private readonly db: DataSource) {}
  persist(
    sessionId: string,
    leaseOwner: string,
    hash: string,
    now: number,
    project: (payload: FinalizationJob["payload"]) => ReportBatch,
  ) {
    return writeTransaction(this.db, async (m) => {
      const q = m
        .getRepository<FinalizationJob>("finalization_jobs")
        .createQueryBuilder("j")
        .where("j.session_id=:sessionId", { sessionId });
      if (m.connection.options.type !== "better-sqlite3") q.setLock("pessimistic_write");
      const job = await q.getOne();
      if (!job || job.payload_hash !== hash) throw new Error("Finalization payload hash mismatch");
      if (
        job.state === "READY" &&
        (await m.existsBy("game_sessions", { id: sessionId, host_id: job.host_id }))
      )
        return sessionId;
      if (
        job.state !== "RUNNING" ||
        job.lease_owner !== leaseOwner ||
        job.lease_until === null ||
        job.lease_until <= now
      )
        throw new Error("RESOURCE_BUSY");
      const data = project(job.payload);
      if (
        data.session.id !== sessionId ||
        data.session.host_id !== job.host_id ||
        data.session.total_questions !== data.questions.length ||
        data.session.total_players !== data.players.length
      )
        throw new Error("Invalid frozen report");
      await m.insert("game_sessions", {
        ...data.session,
        quiz_id: await sourceId(m, "quizzes", data.session.quiz_id),
      });
      const refs = new Map<number, { history: string; source: string | null }>();
      for (const question of data.questions) {
        const history = reportRowId(sessionId, "session_questions/" + question.question_index);
        const source = await sourceId(m, "questions", question.source_question_id);
        await m.insert("session_questions", {
          ...question,
          id: history,
          session_id: sessionId,
          source_question_id: source,
        });
        refs.set(question.question_index, { history, source });
      }
      // Bound statements for large rooms and SQLite bind-parameter limits.
      for (let i = 0; i < data.players.length; i += 32)
        await m.insert(
          "game_players",
          data.players.slice(i, i + 32).map((p) => ({ ...p, session_id: sessionId })),
        );
      for (let i = 0; i < data.answers.length; i += 32) {
        const answers = data.answers.slice(i, i + 32).map((answer) => {
          const ref = refs.get(answer.question_index);
          if (!ref) throw new Error("QUESTION_MISMATCH");
          return {
            ...answer,
            id: reportRowId(
              sessionId,
              "player_answers/" + answer.question_index + "/" + answer.player_id,
            ),
            session_id: sessionId,
            session_question_id: ref.history,
            question_id: ref.source,
          };
        });
        await m.insert("player_answers", answers);
      }
      await m.update("finalization_jobs", sessionId, {
        state: "READY",
        lease_owner: null,
        lease_until: null,
        last_error_code: null,
        completed_at: now,
        updated_at: now,
      });
      return sessionId;
    });
  }
  async session(hostId: string, id: string) {
    const session = await this.db
      .getRepository<SessionRecord>("game_sessions")
      .createQueryBuilder("s")
      .innerJoin("users", "u", "u.id=s.host_id AND u.is_active=:active", { active: true })
      .where("s.id=:id AND s.host_id=:hostId", { id, hostId })
      .getOne();
    if (session) return session;
    const pending = await this.db
      .getRepository<FinalizationJob>("finalization_jobs")
      .createQueryBuilder("j")
      .innerJoin("users", "u", "u.id=j.host_id AND u.is_active=:active", { active: true })
      .where("j.session_id=:id AND j.host_id=:hostId", { id, hostId })
      .getOne();
    if (!pending) throw new Error("NOT_FOUND");
    throw new Error(pending.state === "FAILED" ? "REPORT_SAVE_FAILED" : "FINALIZATION_PENDING");
  }
  async players(hostId: string, id: string, input: unknown) {
    await this.session(hostId, id);
    const { page, limit, search } = reportPlayersQuerySchema.parse(input);
    const q = this.db
      .getRepository<PlayerRecord & { session_id: string }>("game_players")
      .createQueryBuilder("p")
      .where("p.session_id=:id", { id });
    if (search)
      q.andWhere("LOWER(p.nickname) LIKE LOWER(:search) ESCAPE '!'", {
        search: "%" + search.replace(/[!_%]/g, "!$&") + "%",
      });
    const [items, total] = await q
      .orderBy("p.is_kicked", "ASC")
      .addOrderBy("p.final_rank", "ASC")
      .addOrderBy("p.join_order", "ASC")
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }
  async questions(hostId: string, id: string) {
    await this.session(hostId, id);
    return this.db
      .getRepository<QuestionRecord & { session_id: string }>("session_questions")
      .find({ where: { session_id: id }, order: { question_index: "ASC" } });
  }
  async answerPage(hostId: string, id: string, playerId: string, input: unknown) {
    await this.session(hostId, id);
    const { page, limit } = reportAnswersQuerySchema.parse(input);
    if (!(await this.db.manager.existsBy("game_players", { session_id: id, id: playerId })))
      throw new Error("NOT_FOUND");
    const [questions, total] = await this.db
      .getRepository<QuestionRecord & { id: string; session_id: string }>("session_questions")
      .findAndCount({
        where: { session_id: id },
        order: { question_index: "ASC" },
        skip: (page - 1) * limit,
        take: limit,
      });
    const answers = await this.db
      .getRepository<AnswerRecord & { session_id: string }>("player_answers")
      .createQueryBuilder("a")
      .where(
        "a.session_id=:id AND a.player_id=:playerId AND a.question_index>=:first AND a.question_index<:end",
        { id, playerId, first: (page - 1) * limit, end: page * limit },
      )
      .getMany();
    const byIndex = new Map(answers.map((answer) => [answer.question_index, answer]));
    return {
      items: questions.map((question) => ({
        question,
        answer: byIndex.get(question.question_index) ?? null,
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
