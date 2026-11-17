import { randomUUID } from "node:crypto";
import { In, type DataSource, type EntityManager } from "typeorm";
import {
  emptyAccessibility,
  questionMediaIssues,
  quizCreateSchema,
  quizQuerySchema,
  quizWriteSchema,
  type Question,
  type QuizWrite,
  type Option,
} from "@kabuki-neko/shared";
import { writeTransaction } from "../data-source.factory";
import type { MediaRow } from "./media.repository";
import type { UserRow } from "./users.repository";
interface QuizRow {
  id: string;
  creator_id: string;
  title: string;
  description: string | null;
  cover_media_id: string | null;
  visibility: QuizWrite["visibility"];
  bgm_track: string;
  revision: number;
  created_at: number;
  updated_at: number;
}
interface QuestionRow {
  id: string;
  quiz_id: string;
  order_index: number;
  type: Question["type"];
  prompt_text: string;
  media_id: string | null;
  external_video_url: string | null;
  video_start_sec: number;
  video_end_sec: number | null;
  media_reveal_mode: Question["mediaRevealMode"];
  time_limit_sec: Question["timeLimitSec"];
  points_multiplier: Question["pointsMultiplier"];
  explanation_text: string | null;
  accessibility: Question["accessibility"];
}
interface OptionRow {
  id: string;
  question_id: string;
  option_index: number;
  color_index: number;
  option_text: string;
  is_correct: boolean;
  sort_order: number;
}
interface Asset {
  id: string;
  uploader_id: string;
  mime_type: string;
  state: "READY" | "FAILED" | "UPLOADING" | "DELETING";
}
function capabilities(owner: boolean) {
  return { canEdit: owner, canDelete: owner, canDuplicate: true, canExport: true, canHost: true };
}
/**
 * The quiz row if `actor` may see it (owner, or PUBLIC); NOT_FOUND otherwise, FORBIDDEN when
 * `mutate` and not the owner. `lock` takes a row write lock (inside a caller's write transaction);
 * plain reads never lock, so a viewer cannot block the owner's save (code review MJ-08).
 */
async function visibleRow(
  m: EntityManager,
  id: string,
  actor: string,
  mutate: boolean,
  lock = true,
) {
  const query = m
    .getRepository<QuizRow>("quizzes")
    .createQueryBuilder("q")
    .where("q.id=:id", { id });
  if (lock && m.connection.options.type !== "better-sqlite3") query.setLock("pessimistic_write");
  const row = await query.getOne();
  if (!row || (row.creator_id !== actor && row.visibility === "PRIVATE"))
    throw new Error("NOT_FOUND");
  if (mutate && row.creator_id !== actor) throw new Error("FORBIDDEN");
  return row;
}
/** The editable content of one quiz row. */
async function content(m: EntityManager, row: QuizRow): Promise<QuizWrite> {
  const quiz = (await contents(m, [row])).get(row.id);
  if (!quiz) throw new Error("NOT_FOUND");
  return quiz;
}
/**
 * The editable content of several quiz rows with two queries in total (questions, then options),
 * keyed by quiz ID (code review MJ-08: no per-quiz round trips when listing).
 */
async function contents(
  m: EntityManager,
  rows: readonly QuizRow[],
): Promise<Map<string, QuizWrite>> {
  const result = new Map<string, QuizWrite>();
  if (rows.length === 0) return result;
  const allQuestions = await m.getRepository<QuestionRow>("questions").find({
    where: { quiz_id: In(rows.map((row) => row.id)) },
    order: { order_index: "ASC" },
  });
  const options = allQuestions.length
    ? await m.getRepository<OptionRow>("question_options").find({
        where: { question_id: In(allQuestions.map((q) => q.id)) },
        order: { option_index: "ASC" },
      })
    : [];
  const groups = new Map<string, Option[]>();
  for (const opt of options) {
    const group = groups.get(opt.question_id) ?? [];
    group.push({
      id: opt.id,
      optionIndex: opt.option_index,
      colorIndex: opt.color_index,
      optionText: opt.option_text,
      isCorrect: opt.is_correct,
      sortOrder: opt.sort_order,
    });
    groups.set(opt.question_id, group);
  }
  for (const row of rows) {
    const questions = allQuestions.filter((q) => q.quiz_id === row.id);
    result.set(row.id, quizFromRows(row, questions, groups));
  }
  return result;
}
/** Validated QuizWrite from a quiz row, its ordered questions and their option groups. */
function quizFromRows(
  row: QuizRow,
  questions: readonly QuestionRow[],
  groups: ReadonlyMap<string, Option[]>,
): QuizWrite {
  return quizWriteSchema.parse({
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    bgmTrack: row.bgm_track,
    coverMediaId: row.cover_media_id,
    questions: questions.map((q) => ({
      id: q.id,
      orderIndex: q.order_index,
      type: q.type,
      promptText: q.prompt_text,
      mediaId: q.media_id,
      externalVideoUrl: q.external_video_url,
      videoStartSec: q.video_start_sec,
      videoEndSec: q.video_end_sec,
      mediaRevealMode: q.media_reveal_mode,
      timeLimitSec: q.time_limit_sec,
      pointsMultiplier: q.points_multiplier,
      explanationText: q.explanation_text,
      accessibility: q.accessibility,
      options: groups.get(q.id) ?? [],
    })),
  });
}
function refs(quiz: QuizWrite) {
  return new Set(
    [quiz.coverMediaId, ...quiz.questions.map((q) => q.mediaId)].filter(
      (id): id is string => id !== null,
    ),
  );
}
async function validateAssets(
  m: EntityManager,
  actor: string,
  quiz: QuizWrite,
  retained: Set<string>,
) {
  const assets = new Map<string, Asset>();
  for (const id of [...refs(quiz)].sort()) {
    const query = m
      .getRepository<Asset>("media_assets")
      .createQueryBuilder("a")
      .where("a.id=:id", { id });
    if (m.connection.options.type !== "better-sqlite3") query.setLock("pessimistic_write");
    const asset = await query.getOne();
    if (!asset || asset.state !== "READY" || (asset.uploader_id !== actor && !retained.has(id)))
      throw new Error("INVALID_REFERENCE");
    assets.set(id, asset);
  }
  if (quiz.coverMediaId && !assets.get(quiz.coverMediaId)?.mime_type.startsWith("image/"))
    throw new Error("INVALID_REFERENCE");
  for (const q of quiz.questions) {
    const asset = q.mediaId ? assets.get(q.mediaId) : undefined;
    const issues = questionMediaIssues(
      q,
      asset ? { id: asset.id, status: asset.state, mimeType: asset.mime_type } : null,
    );
    if (issues.length) throw new Error(issues[0]?.code);
  }
}
async function validateIds(m: EntityManager, quizId: string, quiz: QuizWrite) {
  const ids = quiz.questions.flatMap((q) => [q.id, ...q.options.map((o) => o.id)]);
  for (let i = 0; i < ids.length; i += 250) {
    const batch = ids.slice(i, i + 250);
    const foreignQuestion = await m
      .getRepository<QuestionRow>("questions")
      .createQueryBuilder("q")
      .where("q.id IN (:...batch) AND q.quiz_id <> :quizId", { batch, quizId })
      .getCount();
    const foreignOption = await m
      .getRepository<OptionRow>("question_options")
      .createQueryBuilder("o")
      .innerJoin("questions", "q", "q.id=o.question_id")
      .where("o.id IN (:...batch) AND q.quiz_id <> :quizId", { batch, quizId })
      .getCount();
    if (foreignQuestion || foreignOption) throw new Error("INVALID_REFERENCE");
  }
}
async function writeSlides(m: EntityManager, id: string, quiz: QuizWrite) {
  for (const q of quiz.questions) {
    await m.insert("questions", {
      id: q.id,
      quiz_id: id,
      order_index: q.orderIndex,
      type: q.type,
      prompt_text: q.promptText,
      media_id: q.mediaId,
      external_video_url: q.externalVideoUrl,
      video_start_sec: q.videoStartSec,
      video_end_sec: q.videoEndSec,
      media_reveal_mode: q.mediaRevealMode,
      time_limit_sec: q.timeLimitSec,
      points_multiplier: q.pointsMultiplier,
      explanation_text: q.explanationText,
      accessibility: q.accessibility,
    });
    if (q.options.length)
      await m.insert(
        "question_options",
        q.options.map((o) => ({
          id: o.id,
          question_id: q.id,
          option_index: o.optionIndex,
          color_index: o.colorIndex,
          option_text: o.optionText,
          is_correct: o.isCorrect,
          sort_order: o.sortOrder,
        })),
      );
  }
}
function metadata(quiz: QuizWrite) {
  return {
    title: quiz.title,
    description: quiz.description,
    cover_media_id: quiz.coverMediaId,
    visibility: quiz.visibility,
    bgm_track: quiz.bgmTrack,
  };
}
async function insertQuiz(m: EntityManager, actor: string, quiz: QuizWrite, now: number) {
  const id = randomUUID();
  await m.insert("quizzes", {
    id,
    creator_id: actor,
    ...metadata(quiz),
    created_at: now,
    updated_at: now,
  });
  await writeSlides(m, id, quiz);
  return id;
}
export class QuizzesRepository {
  constructor(private readonly db: DataSource) {}
  private transaction<T>(
    manager: EntityManager | undefined,
    work: (manager: EntityManager) => Promise<T>,
  ) {
    if (!manager) return writeTransaction(this.db, work);
    if (!manager.queryRunner?.isTransactionActive || manager.connection !== this.db)
      throw new Error("INVALID_REFERENCE");
    return work(manager);
  }
  /**
   * Runs a read-only unit with a consistent view and no row locks (code review MJ-08). PostgreSQL
   * and MySQL use a REPEATABLE READ transaction (snapshot reads, nothing locked); SQLite has one
   * connection, so the read joins the write queue to stay isolated from open write transactions.
   */
  private snapshot<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    if (this.db.options.type === "better-sqlite3") return writeTransaction(this.db, work);
    return this.db.transaction("REPEATABLE READ", work);
  }
  media(ids: readonly string[], manager = this.db.manager) {
    if (manager.connection !== this.db) throw new Error("INVALID_REFERENCE");
    return manager
      .getRepository<MediaRow>("media_assets")
      .find({ where: { id: In([...new Set(ids)]) } });
  }

  list(actor: string, input: unknown) {
    const { page, limit, sort, visibility, scope, search } = quizQuerySchema.parse(input);
    const q = this.db.getRepository<QuizRow>("quizzes").createQueryBuilder("q");
    if (scope === "own") q.where("q.creator_id=:actor", { actor });
    else q.where("q.visibility=:scope", { scope: "PUBLIC" });
    if (visibility) q.andWhere("q.visibility=:visibility", { visibility });
    if (search)
      q.andWhere("LOWER(q.title) LIKE LOWER(:search) ESCAPE '!'", {
        search: "%" + search.replace(/[!_%]/g, "!$&") + "%",
      });
    return q
      .orderBy(
        sort === "title_asc" ? "q.title" : "q.updated_at",
        sort === "title_asc" ? "ASC" : "DESC",
      )
      .addOrderBy("q.id", "ASC")
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount()
      .then(([items, total]) => ({
        items: items.map((row) => ({
          ...row,
          capabilities: capabilities(row.creator_id === actor),
        })),
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      }));
  }
  /**
   * One quiz with its content, creator name, referenced media and the actor's capabilities. With
   * a caller's write transaction (`manager`) the row is locked for that transaction; otherwise the
   * read takes no lock (code review MJ-08).
   */
  read(actor: string, id: string, manager?: EntityManager) {
    const work = async (m: EntityManager) => {
      const row = await visibleRow(m, id, actor, false, manager !== undefined);
      const quiz = await content(m, row);
      const creator = await m
        .getRepository<UserRow>("users")
        .findOneByOrFail({ id: row.creator_id });
      return {
        row,
        content: quiz,
        creatorName: creator.name,
        media: await this.media([...refs(quiz)], m),
        capabilities: capabilities(row.creator_id === actor),
      };
    };
    return manager ? this.transaction(manager, work) : this.snapshot(work);
  }
  /**
   * Batch form of `read` for list pages (code review MJ-08): one lock-free snapshot and a fixed
   * number of queries for any number of IDs. IDs that no longer exist, or that the actor may not
   * see, are simply absent from the result, so a quiz deleted while a page is built does not fail
   * the whole page.
   */
  readMany(actor: string, ids: readonly string[]) {
    return this.snapshot(async (m) => {
      const unique = [...new Set(ids)];
      const rows = unique.length
        ? (await m.getRepository<QuizRow>("quizzes").find({ where: { id: In(unique) } })).filter(
            (row) => row.creator_id === actor || row.visibility !== "PRIVATE",
          )
        : [];
      const quizzes = await contents(m, rows);
      const creators = new Map(
        (rows.length
          ? await m
              .getRepository<UserRow>("users")
              .find({ where: { id: In([...new Set(rows.map((row) => row.creator_id))]) } })
          : []
        ).map((user) => [user.id, user.name]),
      );
      const media = new Map(
        (
          await this.media(
            [...quizzes.values()].flatMap((quiz) => [...refs(quiz)]),
            m,
          )
        ).map((asset) => [asset.id, asset]),
      );
      const result = new Map<string, Awaited<ReturnType<QuizzesRepository["read"]>>>();
      for (const row of rows) {
        const quiz = quizzes.get(row.id);
        const creatorName = creators.get(row.creator_id);
        if (!quiz || creatorName === undefined) continue;
        result.set(row.id, {
          row,
          content: quiz,
          creatorName,
          media: [...refs(quiz)].flatMap((id) => {
            const asset = media.get(id);
            return asset ? [asset] : [];
          }),
          capabilities: capabilities(row.creator_id === actor),
        });
      }
      return result;
    });
  }
  create(actor: string, input: unknown, now: number, manager?: EntityManager) {
    const meta = quizCreateSchema.parse(input);
    const quiz = quizWriteSchema.parse({
      ...meta,
      questions: [
        {
          id: randomUUID(),
          orderIndex: 0,
          type: "SINGLE_CHOICE",
          promptText: "",
          mediaId: null,
          externalVideoUrl: null,
          videoStartSec: 0,
          videoEndSec: null,
          mediaRevealMode: "NONE",
          timeLimitSec: 20,
          pointsMultiplier: 1,
          explanationText: null,
          accessibility: emptyAccessibility(),
          options: [0, 1].map((i) => ({
            id: randomUUID(),
            optionIndex: i,
            colorIndex: i,
            optionText: "",
            isCorrect: i === 0,
            sortOrder: 0,
          })),
        },
      ],
    });
    return this.transaction(manager, async (m) => {
      await validateAssets(m, actor, quiz, new Set());
      return insertQuiz(m, actor, quiz, now);
    });
  }
  importDraft(actor: string, input: unknown, now: number, manager: EntityManager) {
    const draft = quizWriteSchema.parse(input);
    const quiz = quizWriteSchema.parse({
      ...draft,
      visibility: "PRIVATE",
      questions: draft.questions.map((question) => ({
        ...question,
        id: randomUUID(),
        options: question.options.map((option) => ({ ...option, id: randomUUID() })),
      })),
    });
    return this.transaction(manager, async (m) => {
      await validateAssets(m, actor, quiz, new Set());
      return insertQuiz(m, actor, quiz, now);
    });
  }
  save(actor: string, id: string, revision: number, input: unknown, now: number) {
    const quiz = quizWriteSchema.parse(input);
    return writeTransaction(this.db, async (m) => {
      const row = await visibleRow(m, id, actor, true);
      if (row.revision !== revision) throw new Error("REVISION_CONFLICT");
      await validateAssets(m, actor, quiz, refs(await content(m, row)));
      await validateIds(m, id, quiz);
      await m.delete("questions", { quiz_id: id });
      await writeSlides(m, id, quiz);
      await m.update("quizzes", id, { ...metadata(quiz), revision: revision + 1, updated_at: now });
      return revision + 1;
    });
  }
  duplicate(actor: string, id: string, now: number, manager?: EntityManager) {
    return this.transaction(manager, async (m) => {
      const row = await visibleRow(m, id, actor, false),
        quiz = await content(m, row);
      await validateAssets(m, actor, quiz, refs(quiz));
      const copy = quizWriteSchema.parse({
        ...quiz,
        visibility: "PRIVATE",
        questions: quiz.questions.map((q) => ({
          ...q,
          id: randomUUID(),
          options: q.options.map((o) => ({ ...o, id: randomUUID() })),
        })),
      });
      return insertQuiz(m, actor, copy, now);
    });
  }
  delete(actor: string, id: string, revision: number) {
    return writeTransaction(this.db, async (m) => {
      const row = await visibleRow(m, id, actor, true);
      if (row.revision !== revision) throw new Error("REVISION_CONFLICT");
      await m.delete("quizzes", id);
    });
  }
}
