/**
 * GET /system/health with an unavailable rate limiter (code review MJ-10): Redis down must still
 * produce the Health body (503, state "down"), while an exceeded PUBLIC limit stays 429 and an
 * invalid query stays 422.
 */
import type { Request, Response } from "express";
import { ApiError } from "../../common/error.filter";
import { SystemController } from "./system.controller";

const down = {
  status: "degraded",
  database: { status: "up" },
  state: { status: "down", errorCode: "STATE_UNAVAILABLE" },
  storage: { status: "up" },
};

/** Controller with stubbed dependencies; only the limiter and the health check matter here. */
function controller(consume: () => Promise<void>) {
  const health = { check: jest.fn(async () => down) };
  const limiter = { consume: jest.fn(consume) };
  const stub = {} as never;
  return {
    controller: new SystemController(
      stub,
      health as never,
      stub,
      stub,
      stub,
      stub,
      limiter as never,
      stub,
    ),
    health,
  };
}

/** Minimal request/response pair. */
function http(query: Record<string, unknown> = {}) {
  const response = { locals: { clientIp: "198.51.100.7" }, status: jest.fn() };
  return {
    request: { query } as unknown as Request,
    response: response as unknown as Response,
    raw: response,
  };
}

it("reports the state store down (503 Health body) when the limiter is unavailable", async () => {
  const { controller: system, health } = controller(async () => {
    throw new ApiError("DEPENDENCY_UNAVAILABLE", 503);
  });
  const { request, response, raw } = http();
  await expect(system.getHealth(request, response)).resolves.toEqual(down);
  expect(health.check).toHaveBeenCalledTimes(1);
  expect(raw.status).toHaveBeenCalledWith(503);
});

it("still answers 429 for an exceeded limit and 422 for a query string", async () => {
  const limited = controller(async () => {
    throw new ApiError("RATE_LIMITED", 429, { retryAfterMs: 1000 });
  });
  await expect(limited.controller.getHealth(http().request, http().response)).rejects.toMatchObject(
    { errorCode: "RATE_LIMITED" },
  );
  expect(limited.health.check).not.toHaveBeenCalled();
  const unavailable = controller(async () => {
    throw new ApiError("DEPENDENCY_UNAVAILABLE", 503);
  });
  const withQuery = http({ verbose: "1" });
  await expect(
    unavailable.controller.getHealth(withQuery.request, withQuery.response),
  ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
});
