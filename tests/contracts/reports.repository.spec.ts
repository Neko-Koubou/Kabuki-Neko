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
        // TASK-085A: ready-only list, filters, wildcard escaping, pagination and bulk reads.
        const other = randomUUID(),
          second = randomUUID(),
          foreign = randomUUID(),
          pending = randomUUID();
        await db.manager.insert("users", {
          id: other,
          email: "other-reports@example.org",
          password_hash: "fixture",
          name: "Other",
          created_at: 0,
          updated_at: 0,
        });
        const quiz2 = await quizzes.create(host, { title: "Filter" }, 0);
        const ready = (id: string, owner: string, title: string, ended: number, quizId: string) =>
          db.manager.insert("game_sessions", {
            id,
            host_id: owner,
            quiz_id: quizId,
            quiz_title_snapshot: title,
            quiz_revision: 1,
            pin_code: "000002",
            display_mode: "STREAMER",
            end_reason: "HOST_ENDED",
            total_players: 4,
            total_questions: 0,
            played_questions: 0,
            started_at: null,
            ended_at: ended,
            created_at: ended,
            schema_version: 1,
            snapshot: {},
          });
        await ready(second, host, "Weekly 100%_quiz", 10, quiz2);
        await ready(foreign, other, "Frozen", 20, quiz2);
        await db.manager.insert("room_allocations", {
          id: pending,
          pin_code: "000003",
          host_id: host,
          quiz_id: quiz2,
          quiz_revision: 1,
          creation_snapshot: {},
          state_driver: "memory",
          state_namespace: "test",
          status: "FINALIZING",
          created_at: 0,
          expires_at: 100000,
          last_heartbeat_at: 0,
        });
        await jobs.enqueue(pending, host, { title: "Pending" }, 5);
        const ids = async (query: object) =>
          (await reports.list(host, query)).items.map((item) => item.id);
        expect(await ids({})).toEqual([second, session]);
        expect((await reports.list(host, {})).meta).toEqual({
          page: 1,
          limit: 15,
          total: 2,
          totalPages: 1,
        });
        expect(await ids({ search: "100%" })).toEqual([second]);
        expect(await ids({ search: "_" })).toEqual([second]);
        expect(await ids({ search: "FROZEN" })).toEqual([session]);
        expect(await ids({ quizId: quiz2 })).toEqual([second]);
        expect(await ids({ page: "2", limit: "1" })).toEqual([session]);
        expect((await reports.list(other, {})).items.map((item) => item.id)).toEqual([foreign]);
        await expect(reports.list(host, { sort: "rank_asc" })).rejects.toThrow();
        const playerRow = (id: string, join: number, rank: number | null, kicked: boolean) => ({
          id,
          session_id: second,
          nickname: `P${join}`,
          avatar_style: "bottts",
          avatar_seed: `s${join}`,
          join_order: join,
          is_kicked: kicked,
          final_score: 0,
          final_rank: rank,
          correct_count: 0,
          unanswered_count: 0,
          max_streak: 0,
          avg_response_time_ms: null,
          joined_at: join,
          kicked_at: kicked ? join : null,
        });
        const [kicked, rank2, rank1, unranked] = [0, 1, 2, 3].map(() => randomUUID());
        await db.manager.insert("game_players", [
          playerRow(kicked as string, 0, null, true),
          playerRow(rank2 as string, 1, 2, false),
          playerRow(rank1 as string, 2, 1, false),
          playerRow(unranked as string, 3, null, false),
        ]);
        expect((await reports.allPlayers(host, second)).map((p) => p.id)).toEqual([
          rank1,
          rank2,
          unranked,
          kicked,
        ]);
        expect(await reports.allAnswers(host, second)).toEqual([]);
        const answers = await reports.allAnswers(host, session);
        expect(answers.map((a) => [a.question_index, a.player_id, a.result])).toEqual([
          [0, player, "UNANSWERED"],
        ]);
        // Code review MJ-11: outcome and payload aggregation in SQL on every dialect.
        const question = await db.manager.findOneByOrFail<{
          id: string;
          session_id: string;
          question_index: number;
        }>("session_questions", {
          session_id: session,
          question_index: 0,
        });
        const voters = [randomUUID(), randomUUID(), randomUUID()];
        await db.manager.insert(
          "game_players",
          voters.map((id, join) => ({
            ...playerRow(id, join + 1, null, false),
            session_id: session,
          })),
        );
        const answerRow = (
          playerId: string,
          payload: unknown,
          result: string,
          numerator: number,
          denominator: number,
        ) => ({
          id: randomUUID(),
          session_id: session,
          player_id: playerId,
          session_question_id: question.id,
          question_id: null,
          question_index: 0,
          submission_id: randomUUID(),
          submitted_payload: payload,
          result,
          is_correct: result === "CORRECT",
          accuracy_numerator: numerator,
          accuracy_denominator: denominator,
          response_time_ms: 100,
          received_at: 1,
          points_awarded: 0,
          streak_bonus_awarded: 0,
          current_streak: 0,
        });
        await db.manager.insert("player_answers", [
          answerRow(voters[0] as string, [0, 2], "PARTIAL", 1, 2),
          answerRow(voters[1] as string, [0, 2], "PARTIAL", 1, 2),
          answerRow(voters[2] as string, [1], "CORRECT", 1, 1),
        ]);
        const byQuestion = await reports.answerOutcomes(host, session, "question");
        expect(
          byQuestion
            .map((g) => [
              g.key,
              g.result,
              g.accuracyNumerator,
              g.accuracyDenominator,
              g.accepted,
              g.count,
            ])
            .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
        ).toEqual([
          [0, "CORRECT", 1, 1, true, 1],
          [0, "PARTIAL", 1, 2, true, 2],
          [0, "UNANSWERED", 0, 1, false, 1],
        ]);
        const byPlayer = await reports.answerOutcomes(host, session, "player", {
          playerIds: [voters[0] as string, player],
          questionIndexes: [0],
        });
        expect(byPlayer.map((g) => [g.key, g.result, g.count]).sort()).toEqual(
          [
            [voters[0], "PARTIAL", 1],
            [player, "UNANSWERED", 1],
          ].sort(),
        );
        expect(await reports.answerOutcomes(host, session, "player", { playerIds: [] })).toEqual(
          [],
        );
        expect(
          (await reports.payloadCounts(host, session, [0]))
            .map((row) => [row.questionIndex, row.payload, row.count])
            .sort((a, b) => Number(b[2]) - Number(a[2])),
        ).toEqual([
          [0, [0, 2], 2],
          [0, [1], 1],
        ]);
        expect(await reports.payloadCounts(host, session, [])).toEqual([]);
        await expect(reports.answerOutcomes(other, session, "question")).rejects.toThrow(
          "NOT_FOUND",
        );
        await expect(reports.allPlayers(host, pending)).rejects.toThrow("FINALIZATION_PENDING");
        await expect(reports.allAnswers(other, session)).rejects.toThrow("NOT_FOUND");
        await db.manager.update("users", host, { is_active: false });
        await expect(reports.session(host, session)).rejects.toThrow("NOT_FOUND");
        expect((await reports.list(host, {})).items).toEqual([]);
      } finally {
        await db.destroy();
      }
    } finally {
      await rt.cleanup();
    }
  },
);
