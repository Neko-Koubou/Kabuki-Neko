import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { SettingsRepository, OperationsRepository, AuditRepository } from "@kabuki-neko/database";
import { ConfigService } from "../../config/config.service";
import { parseEnvironment } from "../../config/env.schema";
import { AppModule } from "../../app.module";
import { initializeDatabase } from "./database.module";

function config(path: string, extra: Record<string, string> = {}) {
  return new ConfigService(parseEnvironment({ SQLITE_PATH: path, ...extra }), {
    accessSecret: "a".repeat(64),
    refreshSecret: "b".repeat(64),
  });
}
describe("DatabaseModule", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "kabuki-db-di-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it("migrates before DI resolution and closes the connection on shutdown", async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(config(join(directory, "db.sqlite")))
      .compile();
    try {
      await module.init();
      const source = module.get(DataSource);
      expect(source.entityMetadatas).toHaveLength(17);
      expect(await source.manager.existsBy("system_settings", { id: "global" })).toBe(true);
      expect(module.get(SettingsRepository)).toBeInstanceOf(SettingsRepository);
      expect(module.get(OperationsRepository)).toBeInstanceOf(OperationsRepository);
      expect(module.get(AuditRepository)).toBeInstanceOf(AuditRepository);
      await module.close();
      expect(source.isInitialized).toBe(false);
    } finally {
      await module.close();
    }
  });
  it("closes a connection when migrations are disabled on an empty database", async () => {
    const destroy = jest.spyOn(DataSource.prototype, "destroy");
    await expect(
      initializeDatabase(config(join(directory, "empty.sqlite"), { DB_AUTO_MIGRATE: "false" })),
    ).rejects.toThrow("Database initialization failed");
    expect(destroy).toHaveBeenCalledTimes(1);
  });
  it.each(["postgres", "mysql"])(
    "fails closed for unavailable %s without fallback or secrets",
    async (driver) => {
      let selected: string | undefined;
      const initialize = jest
        .spyOn(DataSource.prototype, "initialize")
        .mockImplementation(async function (this: DataSource) {
          selected = this.options.type;
          throw new Error("password=private-secret");
        });
      await expect(
        initializeDatabase(
          config(join(directory, "unused.sqlite"), {
            DB_DRIVER: driver,
            DATABASE_URL: `${driver}://user:private-secret@127.0.0.1:1/database`,
          }),
        ),
      ).rejects.toEqual(new Error("Database initialization failed"));
      expect(initialize).toHaveBeenCalledTimes(1);
      expect(selected).toBe(driver);
    },
  );
});
