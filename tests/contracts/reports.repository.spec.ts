import { randomUUID } from "node:crypto";
import {
  createDataSource,
  domainSchemas,
  migrateDatabase,
  type DatabaseDriver,
} from "../../packages/database/src";
import { JobsRepository } from "../../packages/database/src/repositories/jobs.repository";
import { QuizzesRepository } from "../../packages/database/src/repositories/quizzes.repository";
import {
  ReportsRepository,
  type ReportBatch,
} from "../../packages/database/src/repositories/reports.repository";
import { createTestRuntime } from "../helpers/runtime";
it.each<DatabaseDriver>(["sqlite", "postgres", "mysql"])(
  "%s commits one immutable report or rolls back every batch",
  async (driver) => {
    const rt = await createTestRuntime();
    try {
      const url =
        driver === "sqlite"
          ? undefined
          : (await (driver === "mysql" ? rt.mysql() : rt.postgres())).getConnectionUri();
      const db = createDataSource(
        { driver, sqlitePath: rt.env.SQLITE_PATH ?? ":memory:", ...(url ? { url } : {}) },
        domainSchemas(driver),
      );
      await db.initialize();
      try {
        await migrateDatabase(db, true);
        const session = randomUUID(),
          host = randomUUID(),
          player = randomUUID(),
          jobs = new JobsRepository(db),
          reports = new ReportsRepository(db),
          quizzes = new QuizzesRepository(db);
        await db.manager.insert("users", {
          id: host,
          email: "reports@example.org",
          password_hash: "fixture",
          name: "Host",
          created_at: 0,
          updated_at: 0,
        });
        const quiz = await quizzes.create(host, { title: "Original" }, 0);
        const sourceQuestion = (await quizzes.read(host, quiz)).content.questions[0];
        if (!sourceQuestion) throw new Error("fixture");
        await db.manager.insert("room_allocations", {
          id: session,
          pin_code: "000001",
          host_id: host,
          quiz_id: quiz,
          quiz_revision: 1,
          creation_snapshot: {},
          state_driver: "memory",
          state_namespace: "test",
          status: "FINALIZING",
          created_at: 0,
          expires_at: 100000,
          last_heartbeat_at: 0,
        });
        const job = await jobs.enqueue(session, host, { title: "Frozen" }, 1),
          claim = await jobs.claim(2);
        if (!claim?.lease_owner) throw new Error("Missing claim");
        const owner = claim.lease_owner;
        const project = (payload: Record<string, unknown>): ReportBatch => ({
          session: {
            id: session,
            host_id: host,
            quiz_id: quiz,
            quiz_title_snapshot: String(payload.title),
            quiz_revision: 1,
            pin_code: "000001",
            display_mode: "PROJECTOR",
            end_reason: "COMPLETED",
            total_players: 1,
            total_questions: 1,
            played_questions: 1,
            started_at: 0,
            ended_at: 1,
            created_at: 2,
            schema_version: 1,
            snapshot: { title: payload.title },
          },
          questions: [
            {
              source_question_id: sourceQuestion.id,
              question_index: 0,
              snapshot: { promptText: "Original question" },
              status: "PLAYED",
              opened_at: 0,
              closed_at: 1,
              close_reason: "TIMER",
              eligible_player_ids: [player],
            },
          ],
          players: [
            {
              id: player,
              nickname: "Neko",
              avatar_style: "bottts",
              avatar_seed: "cat",
              join_order: 0,
              is_kicked: false,
              final_score: 0,
              final_rank: 1,
              correct_count: 0,
              unanswered_count: 1,
              max_streak: 0,
              avg_response_time_ms: null,
              joined_at: 0,
              kicked_at: null,
            },
          ],
          answers: [
            {
              player_id: player,
              question_id: sourceQuestion.id,
              question_index: 0,
              submission_id: null,
              submitted_payload: null,
              result: "UNANSWERED",
              is_correct: null,
              accuracy_numerator: 0,
              accuracy_denominator: 1,
              response_time_ms: null,
              received_at: null,
              points_awarded: 0,
              streak_bonus_awarded: 0,
              current_streak: 0,
            },
          ],
        });
        await expect(reports.session(host, session)).rejects.toThrow("FINALIZATION_PENDING");
        for (const table of [
          "game_sessions",
          "session_questions",
          "game_players",
          "player_answers",
        ]) {
          const observer = {
            beforeInsert(event: { metadata: { tableName: string } }) {
              if (event.metadata.tableName === table) throw new Error("batch fixture");
            },
          };
          db.subscribers.push(observer);
          try {
            await expect(
              reports.persist(session, owner, job.payload_hash, 3, project),
            ).rejects.toThrow("batch fixture");
          } finally {
            db.subscribers.splice(db.subscribers.indexOf(observer), 1);
          }
          for (const target of [
            "game_sessions",
            "session_questions",
            "game_players",
            "player_answers",
          ])
            expect(await db.manager.count(target)).toBe(0);
        }
        await quizzes.delete(host, quiz, 1);
        expect(await reports.persist(session, owner, job.payload_hash, 3, project)).toBe(session);
        expect(await reports.persist(session, owner, job.payload_hash, 4, project)).toBe(session);
        await expect(reports.persist(session, owner, "bad", 4, project)).rejects.toThrow(
          "hash mismatch",
        );
        expect((await reports.session(host, session)).quiz_id).toBeNull();
        expect((await reports.session(host, session)).quiz_title_snapshot).toBe("Frozen");
        expect((await reports.questions(host, session))[0]?.source_question_id).toBeNull();
        expect((await reports.players(host, session, {})).items[0]?.id).toBe(player);
        expect((await reports.answerPage(host, session, player, {})).items[0]?.answer?.result).toBe(
          "UNANSWERED",
        );
        await expect(reports.answerPage(host, session, randomUUID(), {})).rejects.toThrow(
          "NOT_FOUND",
        );
        await expect(reports.session(randomUUID(), session)).rejects.toThrow("NOT_FOUND");
        await db.manager.update("users", host, { is_active: false });
        await expect(reports.session(host, session)).rejects.toThrow("NOT_FOUND");
      } finally {
        await db.destroy();
      }
    } finally {
      await rt.cleanup();
    }
  },
);
