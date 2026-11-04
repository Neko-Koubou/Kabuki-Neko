import {
  EntitySchema,
  createDataSource,
  columnTypes,
  safeInteger,
  writeTransaction,
  lockParent,
  type DatabaseDriver,
} from "../../packages/database/src";
import { createTestRuntime } from "../helpers/runtime";

interface Probe {
  id: string;
  total: number;
  payload: unknown;
  label: string;
  enabled: boolean;
}
const id = "00000000-0000-4000-8000-000000000001";
describe("portable database types on real engines", () => {
  it.each<DatabaseDriver>(["sqlite", "postgres", "mysql"])(
    "%s roundtrip, rollback, safe bounds and locking",
    async (driver) => {
      const runtime = await createTestRuntime();
      let source: ReturnType<typeof createDataSource> | undefined;
      try {
        const url =
          driver === "postgres"
            ? (await runtime.postgres()).getConnectionUri()
            : driver === "mysql"
              ? (await runtime.mysql()).getConnectionUri()
              : undefined;
        const types = columnTypes(driver);
        const entity = new EntitySchema<Probe>({
          name: "TypeProbe",
          tableName: "type_probe",
          columns: {
            id: { ...types.id, primary: true },
            total: types.long,
            payload: types.json,
            label: types.text,
            enabled: types.boolean,
          },
          checks: driver === "sqlite" ? [{ expression: "enabled IN (0,1)" }] : [],
        });
        source = createDataSource(
          { driver, sqlitePath: runtime.env.SQLITE_PATH ?? ":memory:", ...(url ? { url } : {}) },
          [entity],
        );
        expect(source.options.synchronize).toBe(false);
        await source.initialize();
        // Test-only schema creation; application factory never synchronizes.
        await source.synchronize();
        const value: Probe = {
          id,
          total: Number.MAX_SAFE_INTEGER,
          payload: { text: "猫👨‍👩‍👧‍👦", list: [1, true, null] },
          label: "中文 e\u0301",
          enabled: true,
        };
        await writeTransaction(source, (manager) => manager.save("TypeProbe", value));
        expect(await source.getRepository<Probe>("TypeProbe").findOneByOrFail({ id })).toEqual(
          value,
        );
        await expect(
          writeTransaction(source, async (manager) => {
            await lockParent(manager, "TypeProbe", id);
            await manager.update("TypeProbe", id, { label: "rolled back" });
            throw new Error("rollback probe");
          }),
        ).rejects.toThrow("rollback probe");
        expect((await source.getRepository<Probe>("TypeProbe").findOneByOrFail({ id })).label).toBe(
          value.label,
        );
        await expect(
          writeTransaction(source, (manager) =>
            manager.update("TypeProbe", id, { total: Number.MAX_SAFE_INTEGER + 1 }),
          ),
        ).rejects.toThrow("Unsafe database integer");
        await writeTransaction(source, (manager) =>
          manager.update("TypeProbe", id, { enabled: false }),
        );
        expect(
          (await source.getRepository<Probe>("TypeProbe").findOneByOrFail({ id })).enabled,
        ).toBe(false);
        let attempts = 0;
        await writeTransaction(source, async (manager) => {
          await manager.update("TypeProbe", id, { label: "retried" });
          if (++attempts < 3)
            throw Object.assign(new Error("transient fixture"), { code: "40001" });
        });
        expect(attempts).toBe(3);
        if (driver === "sqlite") {
          const runner = source.createQueryRunner();
          const spy = jest.spyOn(runner, "query");
          await writeTransaction(source, async (manager) => {
            await lockParent(manager, "TypeProbe", id);
          });
          expect(spy.mock.calls.some((call) => call[0] === "BEGIN IMMEDIATE")).toBe(true);
          spy.mockRestore();
        }
        if (driver === "sqlite") {
          expect(await source.query("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
          expect(await source.query("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
          await expect(source.query("UPDATE type_probe SET enabled = 2")).rejects.toThrow();
        }
      } finally {
        if (source?.isInitialized) await source.destroy();
        await runtime.cleanup();
      }
    },
  );
  it("rejects unsafe or malformed driver integer representations", () => {
    for (const value of ["9007199254740992", 1.5, null, "", "1e3", Infinity])
      expect(() => safeInteger(value)).toThrow();
    expect(safeInteger("-9007199254740991")).toBe(Number.MIN_SAFE_INTEGER);
  });
});
