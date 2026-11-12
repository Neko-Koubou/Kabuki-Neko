/**
 * Administrative audit events (code review MJ-02; SA §10.1; AC-20-01): role and status changes,
 * invitation creation and refresh-token reuse are recorded with the actor, the resource ID, the
 * outcome (SUCCESS, DENIED for the last-SUPERADMIN policy, FAILURE otherwise) and the error code,
 * never with request bodies, invite codes or tokens.
 */
import type { Request, Response } from "express";
import { ApiError } from "../../common/error.filter";
import type { AuditService } from "../../common/audit.service";
import type { JwtGuard, VerifiedPrincipal } from "../../common/guards/jwt.guard";
import type { RateLimitService } from "../../common/rate-limit.service";
import type { ConfigService } from "../../config/config.service";
import { AuthController } from "../auth/auth.controller";
import type { AuthService } from "../auth/auth.service";
import { RefreshReuseError, type RefreshService } from "../auth/refresh.service";
import type { SetupService } from "../auth/setup.service";
import type { InvitationsService } from "./invitations.service";
import { UsersController } from "./users.controller";
import type { UsersService } from "./users.service";

const ACTOR = "0f2c1d7e-5a4b-4c3d-9e8f-1a2b3c4d5e6f";
const TARGET = "7b9e2c41-3d5f-4a6b-8c7d-9e0f1a2b3c4d";
const INVITATION = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const CORRELATION = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const principal = { user: { id: ACTOR } } as VerifiedPrincipal;

/** Records every audit event passed to `record`. */
function auditSpy() {
  const events: Record<string, unknown>[] = [];
  const audit = {
    record: jest.fn(async (event: Record<string, unknown>) => {
      events.push(event);
    }),
  } as unknown as AuditService;
  return { audit, events };
}

/** Minimal Express doubles carrying what the controllers read. */
function http(headers: Record<string, string> = {}, cookies: Record<string, string> = {}) {
  const request = {
    query: {},
    cookies,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  const response = {
    locals: { correlationId: CORRELATION, clientIp: "203.0.113.9" },
    setHeader: jest.fn(),
    cookie: jest.fn(),
  } as unknown as Response;
  return { request, response };
}

/** UsersController with a scripted users/invitations service. */
function usersController(
  patch: UsersService["patch"],
  create: InvitationsService["create"] = jest.fn(),
) {
  const { audit, events } = auditSpy();
  const controller = new UsersController(
    { patch } as unknown as UsersService,
    { create } as unknown as InvitationsService,
    { principal: () => principal } as unknown as JwtGuard,
    { consume: async () => undefined } as unknown as RateLimitService,
    audit,
  );
  return { controller, events };
}

it("audits a role and status change as SUCCESS on the target user", async () => {
  const { controller, events } = usersController(jest.fn(async () => ({ revision: 2 }) as never));
  const { request, response } = http({ "if-match": '"1"' });
  await controller.patch(request, TARGET, { role: "CREATOR", isActive: false }, response);
  expect(events).toEqual([
    expect.objectContaining({
      actorType: "USER",
      actorId: ACTOR,
      action: "user.role.change",
      resourceId: TARGET,
      outcome: "SUCCESS",
      errorCode: null,
      correlationId: CORRELATION,
    }),
    expect.objectContaining({ action: "user.status.change", outcome: "SUCCESS" }),
  ]);
});

it("audits the last-SUPERADMIN refusal as DENIED and other failures as FAILURE", async () => {
  const denied = usersController(
    jest.fn(async () => {
      throw new ApiError("LAST_SUPERADMIN", 409);
    }),
  );
  const first = http({ "if-match": '"1"' });
  await expect(
    denied.controller.patch(first.request, TARGET, { role: "CREATOR" }, first.response),
  ).rejects.toMatchObject({ errorCode: "LAST_SUPERADMIN" });
  expect(denied.events).toEqual([
    expect.objectContaining({
      action: "user.role.change",
      outcome: "DENIED",
      errorCode: "LAST_SUPERADMIN",
    }),
  ]);
  const conflict = usersController(
    jest.fn(async () => {
      throw new ApiError("REVISION_CONFLICT", 409);
    }),
  );
  const second = http({ "if-match": '"1"' });
  await expect(
    conflict.controller.patch(second.request, TARGET, { isActive: true }, second.response),
  ).rejects.toMatchObject({ errorCode: "REVISION_CONFLICT" });
  expect(conflict.events).toEqual([
    expect.objectContaining({ action: "user.status.change", outcome: "FAILURE" }),
  ]);
});

it("audits invitation creation with the invitation ID and never the invite code", async () => {
  const { controller, events } = usersController(
    jest.fn(),
    jest.fn(async () => ({
      httpStatus: 201,
      response: { invitation: { id: INVITATION }, inviteCode: "secret-invite-code" },
    })) as never,
  );
  const { request, response } = http({ "idempotency-key": TARGET });
  await controller.createInvitation(request, { expiresInHours: 24 }, response);
  expect(events).toEqual([
    expect.objectContaining({
      action: "invitation.create",
      resourceId: INVITATION,
      outcome: "SUCCESS",
    }),
  ]);
  expect(JSON.stringify(events)).not.toContain("secret-invite-code");
});

it("audits refresh-token reuse as DENIED for the token's user and still answers TOKEN_REVOKED", async () => {
  const { audit, events } = auditSpy();
  const controller = new AuthController(
    {} as AuthService,
    {} as SetupService,
    {
      rotate: async () => {
        throw new RefreshReuseError(TARGET);
      },
    } as unknown as RefreshService,
    {} as JwtGuard,
    { consume: async () => undefined } as unknown as RateLimitService,
    {} as ConfigService,
    audit,
  );
  const { request, response } = http({}, { refresh_token: "consumed.refresh.token" });
  await expect(controller.rotate(request, response, {})).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
  expect(events).toEqual([
    expect.objectContaining({
      actorType: "USER",
      actorId: TARGET,
      action: "auth.refresh.reuse",
      resourceId: null,
      outcome: "DENIED",
      errorCode: "TOKEN_REVOKED",
    }),
  ]);
  expect(JSON.stringify(events)).not.toContain("consumed.refresh.token");
});
