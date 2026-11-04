import { EntitySchema } from "typeorm";
import { columnTypes, type DatabaseDriver } from "./column-types";
export function quizzesSchemas(driver: DatabaseDriver) {
  const t = columnTypes(driver);
  return [
    new EntitySchema({
      name: "quizzes",
      columns: {
        id: { ...t.id, primary: true },
        creator_id: { ...t.id },
        title: { ...t.text },
        description: { ...t.text, nullable: true },
        cover_media_id: { ...t.id, nullable: true },
        visibility: { ...t.string(10), default: "PRIVATE" },
        bgm_track: { ...t.string(100), default: "random" },
        revision: { ...t.integer, default: 1 },
        created_at: { ...t.long },
        updated_at: { ...t.long },
      },
      indices: [
        { columns: ["creator_id", "updated_at", "id"], unique: false },
        { columns: ["visibility", "updated_at", "id"], unique: false },
        { columns: ["cover_media_id"] },
      ],
      foreignKeys: [
        {
          target: "users",
          columnNames: ["creator_id"],
          referencedColumnNames: ["id"],
          onDelete: "RESTRICT",
          onUpdate: "NO ACTION",
        },
        {
          target: "media_assets",
          columnNames: ["cover_media_id"],
          referencedColumnNames: ["id"],
          onDelete: "RESTRICT",
          onUpdate: "NO ACTION",
        },
      ],
      checks: [
        ...[{ expression: "visibility IN ('PRIVATE','PUBLIC')" }],
        ...(driver === "sqlite" ? [] : []),
      ],
    }),
    new EntitySchema({
      name: "questions",
      columns: {
        id: { ...t.id, primary: true },
        quiz_id: { ...t.id },
        order_index: { ...t.integer, default: 0 },
        type: { ...t.string(30), default: "SINGLE_CHOICE" },
        prompt_text: { ...t.text, default: "" },
        media_id: { ...t.id, nullable: true },
        external_video_url: { ...t.string(500), nullable: true },
        video_start_sec: { ...t.integer, default: 0 },
        video_end_sec: { ...t.integer, nullable: true },
        media_reveal_mode: { ...t.string(20), default: "NONE" },
        time_limit_sec: { ...t.integer, default: 20 },
        points_multiplier: { ...t.integer, default: 1 },
        explanation_text: { ...t.text, nullable: true },
        accessibility: {
          ...t.json,
          default: '{"altText":null,"transcript":null,"captions":[],"visualDescription":null}',
        },
      },
      indices: [{ columns: ["quiz_id", "order_index"], unique: true }, { columns: ["media_id"] }],
      foreignKeys: [
        {
          target: "quizzes",
          columnNames: ["quiz_id"],
          referencedColumnNames: ["id"],
          onDelete: "CASCADE",
          onUpdate: "NO ACTION",
        },
        {
          target: "media_assets",
          columnNames: ["media_id"],
          referencedColumnNames: ["id"],
          onDelete: "RESTRICT",
          onUpdate: "NO ACTION",
        },
      ],
      checks: [
        ...[
          { expression: "order_index >= 0" },
          { expression: "time_limit_sec IN (5,10,20,30,60,90,120,240)" },
          { expression: "points_multiplier IN (0,1,2)" },
          {
            expression:
              "type IN ('SINGLE_CHOICE','TRUE_FALSE','MULTIPLE_SELECT','TYPE_ANSWER','ORDER_PUZZLE','POLL')",
          },
          { expression: "media_reveal_mode IN ('NONE','GRID_3X3','GRID_5X5','BLUR')" },
          { expression: "media_id IS NULL OR external_video_url IS NULL" },
        ],
        ...(driver === "sqlite" ? [] : []),
      ],
    }),
    new EntitySchema({
      name: "question_options",
      columns: {
        id: { ...t.id, primary: true },
        question_id: { ...t.id },
        option_index: { ...t.integer },
        color_index: { ...t.integer, default: 0 },
        option_text: { ...t.text, default: "" },
        is_correct: { ...t.boolean, default: false },
        sort_order: { ...t.integer, default: 0 },
      },
      indices: [
        { columns: ["question_id", "option_index"], unique: true },
        { columns: ["question_id", "sort_order"], unique: false },
      ],
      foreignKeys: [
        {
          target: "questions",
          columnNames: ["question_id"],
          referencedColumnNames: ["id"],
          onDelete: "CASCADE",
          onUpdate: "NO ACTION",
        },
      ],
      checks: [
        ...[
          { expression: "color_index BETWEEN 0 AND 3" },
          { expression: "option_index BETWEEN 0 AND 19" },
        ],
        ...(driver === "sqlite" ? [{ expression: "is_correct IN (0,1)" }] : []),
      ],
    }),
  ];
}
