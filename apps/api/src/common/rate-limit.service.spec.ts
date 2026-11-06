import { GenericContainer, type StartedTestContainer } from "testcontainers";
import Redis from "ioredis";
import { RateLimitService } from "./rate-limit.service";
import { clientIp, normalizeIp, OriginGuard, trustedProxies } from "./guards/origin.guard";

let container: StartedTestContainer;
let redis: Redis;
beforeAll(async () => {
  container = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
  redis = new Redis({
    host: container.getHost(),
    port: container.getMappedPort(6379),
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
  });
  await new Promise<void>((resolve, reject) => {
    redis.once("ready", resolve);
    redis.once("error", reject);
  });
}, 60000);
afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
});

for (const driver of ["memory", "redis"] as const)
  describe(`${driver} limiter`, () => {
    let limiter: RateLimitService;
    beforeEach(() => {
      limiter = new RateLimitService(
        driver === "redis" ? redis : null,
        `${driver}-${Math.random()}`,
      );
    });
    it("charges check and join against one ten-request budget including concurrent requests", async () => {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 20 }, () => limiter.consume("CHECK_JOIN", "192.0.2.1")),
      );
      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(10);
      for (const outcome of outcomes)
        if (outcome.status === "rejected")
          expect(outcome.reason).toMatchObject({
            errorCode: "RATE_LIMITED",
            params: { retryAfterMs: expect.any(Number) },
          });
      await expect(limiter.consume("CHECK_JOIN", "192.0.2.2")).resolves.toBeUndefined();
    });
    it("enforces both answer windows without consuming another slot on rejection", async () => {
      for (let i = 0; i < 5; i++) await limiter.consume("ANSWER", "player");
      await expect(limiter.consume("ANSWER", "player")).rejects.toMatchObject({
        errorCode: "RATE_LIMITED",
      });
    });
    it("allows two uploads and frees only the released token", async () => {
      const [a, b] = await Promise.all([
        limiter.acquire("UPLOAD", "actor"),
        limiter.acquire("UPLOAD", "actor"),
      ]);
      await expect(limiter.acquire("UPLOAD", "actor")).rejects.toMatchObject({
        errorCode: "RATE_LIMITED",
      });
      await a.renew();
      await a.release();
      await a.release();
      const c = await limiter.acquire("UPLOAD", "actor");
      await expect(limiter.acquire("UPLOAD", "actor")).rejects.toMatchObject({
        errorCode: "RATE_LIMITED",
      });
      await Promise.all([b.release(), c.release()]);
      await expect(a.renew()).rejects.toMatchObject({ errorCode: "DEPENDENCY_UNAVAILABLE" });
    });
  });
it("uses shared Redis budgets and fails closed on dependency errors", async () => {
  const first = new RateLimitService(redis, "shared"),
    second = new RateLimitService(redis, "shared");
  await first.consume("CLEANUP", "instance");
  await expect(second.consume("CLEANUP", "instance")).rejects.toMatchObject({
    errorCode: "RATE_LIMITED",
  });
  const call = jest.spyOn(redis, "eval").mockRejectedValue(new Error("connection secret"));
  try {
    await expect(second.consume("AUTH", "ip")).rejects.toMatchObject({
      errorCode: "DEPENDENCY_UNAVAILABLE",
    });
    await expect(second.acquire("UPLOAD", "actor")).rejects.toMatchObject({
      errorCode: "DEPENDENCY_UNAVAILABLE",
    });
  } finally {
    call.mockRestore();
  }
});
it("expires the sliding window precisely and keeps the minute answer cap", async () => {
  let now = 100000;
  const limiter = new RateLimitService(null, "clock", () => now);
  for (let second = 0; second < 6; second++) {
    for (let i = 0; i < 5; i++) await limiter.consume("ANSWER", "player");
    now += 1000;
  }
  await expect(limiter.consume("ANSWER", "player")).rejects.toMatchObject({
    errorCode: "RATE_LIMITED",
  });
  now = 159999;
  await expect(limiter.consume("ANSWER", "player")).rejects.toMatchObject({
    params: { retryAfterMs: 1 },
  });
  now++;
  await expect(limiter.consume("ANSWER", "player")).resolves.toBeUndefined();
});
it("expires crashed-worker concurrency leases without reviving old tokens", async () => {
  let now = 1000;
  const limiter = new RateLimitService(null, "leases", () => now);
  const old = await limiter.acquire("CLEANUP", "instance");
  now += 120000;
  const next = await limiter.acquire("CLEANUP", "instance");
  await old.release();
  await expect(old.renew()).rejects.toMatchObject({ errorCode: "DEPENDENCY_UNAVAILABLE" });
  await expect(limiter.acquire("CLEANUP", "instance")).rejects.toMatchObject({
    errorCode: "RATE_LIMITED",
  });
  await next.release();
});
it("ignores spoofed forwarding from untrusted clients and stops at the nearest untrusted hop", () => {
  const trusted = trustedProxies(["10.0.0.0/8", "2001:db8::/32"]);
  expect(clientIp("192.0.2.10", "1.1.1.1", trusted)).toBe("192.0.2.10");
  expect(clientIp("::ffff:10.0.0.2", "1.1.1.1, 192.0.2.10, 10.0.0.1", trusted)).toBe("192.0.2.10");
  expect(clientIp("2001:db8::1", "192.0.2.10", trusted)).toBe("192.0.2.10");
  expect(normalizeIp("2001:0db8:0:0:0:0:0:1")).toBe("2001:db8::1");
});
it("requires exact Origin and the mutation client header, without suffix matching", () => {
  const guard = new OriginGuard(["https://quiz.example"]);
  expect(() => guard.assert("https://quiz.example", "web-v1")).not.toThrow();
  for (const origin of [
    undefined,
    "null",
    "https://quiz.example.evil",
    "https://quiz.example/",
    "http://quiz.example",
  ])
    expect(() => guard.assert(origin, "web-v1")).toThrow("ORIGIN_DENIED");
  expect(() => guard.assert("https://quiz.example", "")).toThrow("ORIGIN_DENIED");
});
