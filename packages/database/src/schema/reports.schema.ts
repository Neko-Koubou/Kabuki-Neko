import { EntitySchema } from "typeorm";
import { columnTypes, type DatabaseDriver } from "./column-types";
export function reportsSchemas(driver: DatabaseDriver) {
  const t = columnTypes(driver);
  return [
    new EntitySchema({
      name: "game_sessions",
      columns: {
        id: { ...t.id, primary: true },
        quiz_id: { ...t.id, nullable: true },
        quiz_title_snapshot: { ...t.text },
        quiz_revision: { ...t.integer },
        host_id: { ...t.id },
        pin_code: { ...t.string(6) },
        display_mode: { ...t.string(10) },
        end_reason: { ...t.string(20) },
        total_players: { ...t.integer },
        total_questions: { ...t.integer },
        played_questions: { ...t.integer },
        started_at: { ...t.long, nullable: true },
        ended_at: { ...t.long },
        created_at: { ...t.long },
        schema_version: { ...t.integer, default: 1 },
        snapshot: { ...t.json },
      },
      indices: [
        { columns: ["host_id", "ended_at", "id"], unique: false },
        { columns: ["host_id", "quiz_id", "ended_at"], unique: false },
        { columns: ["quiz_id"] },
      ],
      foreignKeys: [
        {
          target: "users",
          columnNames: ["host_id"],
          referencedColumnNames: ["id"],
          onDelete: "RESTRICT",
          onUpdate: "NO ACTION",
        },
        {
          target: "quizzes",
          columnNames: ["quiz_id"],
          referencedColumnNames: ["id"],
          onDelete: "SET NULL",
          onUpdate: "NO ACTION",
        },
      ],
      checks: [
        ...[
          { expression: "display_mode IN ('PROJECTOR','STREAMER')" },
          { expression: "end_reason IN ('COMPLETED','HOST_ENDED','EXPIRED')" },
        ],
        ...(driver === "sqlite" ? [] : []),
      ],
    }),
    new EntitySchema({
      name: "session_questions",
      columns: {
        id: { ...t.id, primary: true },
        session_id: { ...t.id },
        source_question_id: { ...t.id, nullable: true },
        question_index: { ...t.integer },
        snapshot: { ...t.json },
        status: { ...t.string(12) },
        opened_at: { ...t.long, nullable: true },
        closed_at: { ...t.long, nullable: true },
        close_reason: { ...t.string(16), nullable: true },
        eligible_player_ids: { ...t.json, default: "[]" },
      },
      indices: [
        { columns: ["session_id", "question_index"], unique: true },
        { columns: ["session_id", "id"], unique: true },
        { columns: ["source_question_id"] },
      ],
      foreignKeys: [
        {
          target: "game_sessions",
          columnNames: ["session_id"],
          referencedColumnNames: ["id"],
          onDelete: "CASCADE",
          onUpdate: "NO ACTION",
        },
        {
          target: "questions",
          columnNames: ["source_question_id"],
          referencedColumnNames: ["id"],
          onDelete: "SET NULL",
          onUpdate: "NO ACTION",
        },
      ],
      checks: [
        ...[{ expression: "status IN ('UNPLAYED','PLAYED')" }],
        ...(driver === "sqlite" ? [] : []),
      ],
    }),
    new EntitySchema({
      name: "game_players",
      columns: {
        id: { ...t.id, primary: true },
        session_id: { ...t.id },
        nickname: { ...t.text },
        avatar_style: { ...t.string(50) },
        avatar_seed: { ...t.string(100) },
        join_order: { ...t.integer },
        is_kicked: { ...t.boolean, default: false },
        final_score: { ...t.integer, default: 0 },
        final_rank: { ...t.integer, nullable: true },
        correct_count: { ...t.integer, default: 0 },
        unanswered_count: { ...t.integer, default: 0 },
        max_streak: { ...t.integer, default: 0 },
        avg_response_time_ms: { ...t.long, nullable: true },
        joined_at: { ...t.long },
        kicked_at: { ...t.long, nullable: true },
      },
      indices: [
        { columns: ["session_id", "id"], unique: true },
        { columns: ["session_id", "join_order"], unique: true },
        { columns: ["session_id", "final_rank"], unique: false },
      ],
      foreignKeys: [
        {
          target: "game_sessions",
          columnNames: ["session_id"],
          referencedColumnNames: ["id"],
          onDelete: "CASCADE",
          onUpdate: "NO ACTION",
        },
      ],
      checks: [...[], ...(driver === "sqlite" ? [{ expression: "is_kicked IN (0,1)" }] : [])],
    }),
    new EntitySchema({
      name: "player_answers",
      columns: {
        id: { ...t.id, primary: true },
        session_id: { ...t.id },
        player_id: { ...t.id },
        session_question_id: { ...t.id },
        question_id: { ...t.id, nullable: true },
        question_index: { ...t.integer },
        submission_id: { ...t.id, nullable: true },
        submitted_payload: { ...t.json, nullable: true },
        result: { ...t.string(16) },
        is_correct: { ...t.boolean, nullable: true },
        accuracy_numerator: { ...t.integer, default: 0 },
        accuracy_denominator: { ...t.integer, default: 1 },
        response_time_ms: { ...t.long, nullable: true },
        received_at: { ...t.long, nullable: true },
        points_awarded: { ...t.integer, default: 0 },
        streak_bonus_awarded: { ...t.integer, default: 0 },
        current_streak: { ...t.integer, default: 0 },
      },
      indices: [
        { columns: ["session_id", "player_id", "question_index"], unique: true },
        { columns: ["session_id", "session_question_id"] },
        { columns: ["question_id"] },
      ],
      foreignKeys: [
        {
          target: "game_players",
          columnNames: ["session_id", "player_id"],
          referencedColumnNames: ["session_id", "id"],
          onDelete: "CASCADE",
          onUpdate: "NO ACTION",
        },
        {
          target: "session_questions",
          columnNames: ["session_id", "session_question_id"],
          referencedColumnNames: ["session_id", "id"],
          onDelete: "CASCADE",
          onUpdate: "NO ACTION",
        },
        {
          target: "questions",
          columnNames: ["question_id"],
          referencedColumnNames: ["id"],
          onDelete: "SET NULL",
          onUpdate: "NO ACTION",
        },
      ],
      checks: [
        ...[
          {
            expression:
              "result IN ('CORRECT','PARTIAL','INCORRECT','UNANSWERED','POLL','NOT_ELIGIBLE')",
          },
        ],
        ...(driver === "sqlite" ? [{ expression: "is_correct IN (0,1)" }] : []),
      ],
    }),
  ];
}
