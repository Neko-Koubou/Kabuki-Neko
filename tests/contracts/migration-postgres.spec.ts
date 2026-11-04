import { createDataSource, domainSchemas } from "../../packages/database/src";
import { initialMigration } from "../../packages/database/src/migrations/postgres/0001-initial";
import { createTestRuntime } from "../helpers/runtime";
it("applies initial postgres migration twice and preserves user changes", async () => {
  const runtime = await createTestRuntime();
  try {
    const source = createDataSource(
      {
        driver: "postgres",
        sqlitePath: runtime.env.SQLITE_PATH ?? ":memory:",
        url: (await runtime.postgres()).getConnectionUri(),
      },
      domainSchemas("postgres"),
    );
    await source.initialize();
    const r = source.createQueryRunner();
    try {
      await initialMigration.up(r);
      for (const entity of source.entityMetadatas)
        expect(await r.hasTable(entity.tableName)).toBe(true);
      expect(source.entityMetadatas.length).toBe(17);
      expect(
        (await r.query("SELECT registration_mode FROM system_settings WHERE id='global'"))[0]
          .registration_mode,
      ).toBe("PUBLIC");
      await r.query("UPDATE system_settings SET max_players_per_room=345 WHERE id='global'");
      await initialMigration.up(r);
      expect(
        (await r.query("SELECT max_players_per_room FROM system_settings"))[0].max_players_per_room,
      ).toBe(345);
      await expect(
        r.query("UPDATE system_settings SET registration_mode='INVALID'"),
      ).rejects.toThrow();
      const userId = "00000000-0000-4000-8000-000000000001",
        quizId = "00000000-0000-4000-8000-000000000002";
      await r.manager.insert("users", {
        id: userId,
        email: "probe@example.com",
        password_hash: "test",
        name: "Probe",
        created_at: 1,
        updated_at: 1,
      });
      await r.manager.insert("quizzes", {
        id: quizId,
        creator_id: userId,
        title: "Quiz",
        created_at: 1,
        updated_at: 1,
      });
      expect((await r.query("SELECT bgm_track FROM quizzes"))[0].bgm_track).toBe("random");
      await r.manager.update("quizzes", quizId, { bgm_track: "custom-lobby" });
      expect((await r.query("SELECT bgm_track FROM quizzes"))[0].bgm_track).toBe("custom-lobby");
      await expect(r.manager.delete("users", userId)).rejects.toThrow();
    } finally {
      await r.release();
      await source.destroy();
    }
  } finally {
    await runtime.cleanup();
  }
});
