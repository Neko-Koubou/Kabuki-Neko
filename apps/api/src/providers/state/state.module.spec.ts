/**
 * TASK-185A: a failed Socket.io Redis adapter publish must not crash the API node.
 * `@socket.io/redis-adapter` publishes without awaiting or catching; `guardPublish` makes such
 * fire-and-forget publishes resolve, count the failure and leave other commands untouched.
 * Jest itself fails a test on any unhandled rejection, so an unguarded publish (the old code)
 * fails these cases even before their assertions.
 */
import Redis from "ioredis";
import { guardPublish, type Publisher } from "./state.module";

/** Unhandled rejections seen while `run` executes (after the rejections had time to surface). */
async function unhandledDuring(run: () => void): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", listener);
  try {
    run();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off("unhandledRejection", listener);
  }
  return seen;
}

/** An ioredis client that never connects: every command rejects at once, like an outage. */
function offlineClient() {
  return new Redis({ lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
}

it("guards a real ioredis client: failed publishes resolve to 0 and are counted", async () => {
  const client = offlineClient();
  const failures: unknown[] = [];
  guardPublish(client as unknown as Publisher, (error) => failures.push(error));
  try {
    const results: unknown[] = [];
    const seen = await unhandledDuring(() => {
      void client.publish("channel", "message").then((value) => results.push(value));
    });
    expect(seen).toEqual([]);
    expect(results).toEqual([0]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(Error);
    // Other commands still reject to their callers.
    await expect(client.get("key")).rejects.toThrow();
  } finally {
    client.disconnect();
  }
});

it("passes successful publishes and their arguments through unchanged", async () => {
  const calls: unknown[][] = [];
  const failures: unknown[] = [];
  const client = {
    receivers: 2,
    publish(...args: unknown[]) {
      calls.push(args);
      return Promise.resolve(this.receivers);
    },
  };
  guardPublish(client as unknown as Publisher, (error) => failures.push(error));
  await expect(client.publish("room", "payload")).resolves.toBe(2);
  expect(calls).toEqual([["room", "payload"]]);
  expect(failures).toEqual([]);
});

it("absorbs timeouts and closed connections alike", async () => {
  const errors = [new Error("Command timed out"), new Error("Connection is closed.")];
  let next = 0;
  const failures: unknown[] = [];
  const client = { publish: () => Promise.reject(errors[next++]) };
  guardPublish(client as unknown as Publisher, (error) => failures.push(error));
  const seen = await unhandledDuring(() => {
    void client.publish();
    void client.publish();
  });
  expect(seen).toEqual([]);
  expect(failures).toEqual(errors);
});
