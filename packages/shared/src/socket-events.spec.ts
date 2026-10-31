import { describe, expect, it } from "vitest";
import { internalError } from "./errors";
import {
  clientContracts,
  type ClientEventName,
  handshakeSchema,
  hostPodiumDataSchema,
  playerEventDataSchemas,
  playerPodiumDataSchema,
  pushEnvelopeSchema,
  serverEventDataSchemas,
} from "./socket-events";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const requestId = uuid(1);
const member = { requestId, sessionId: uuid(2), pinCode: "123456" };
const phase = { ...member, expectedPhaseVersion: 1 };
const avatar = { style: "bottts", seed: "neko" };
const requests: Record<ClientEventName, unknown> = {
  "auth:update": { requestId, accessToken: "synthetic-token" },
  "host:create_room": {
    requestId,
    quizId: uuid(3),
    quizRevision: 1,
    displayMode: "PROJECTOR",
    friendlyNicknames: false,
  },
  "host:recover_room": { requestId, sessionId: uuid(2) },
  "host:lock_room": { ...member, isLocked: true },
  "host:kick_player": { ...member, playerId: uuid(4) },
  "host:start_game": phase,
  "host:skip_timer": phase,
  "host:next_step": phase,
  "host:end_game": phase,
  "player:check_pin": { requestId, pinCode: "123456" },
  "player:request_friendly_name": { requestId, pinCode: "123456" },
  "player:join_room": { requestId, pinCode: "123456", nickname: "Neko", avatar },
  "player:update_avatar": { ...member, avatar },
  "player:submit_answer": {
    ...member,
    questionIndex: 0,
    questionId: uuid(3),
    submissionId: uuid(4),
    answer: [0, 1],
  },
  "room:sync": member,
  "room:time": { ...member, clientSentAt: 0 },
};
describe("all client methods and ACKs", () => {
  it("defines exactly16 methods with strict request identity and matching error envelopes", () => {
    expect(Object.keys(clientContracts)).toHaveLength(16);
    for (const name of Object.keys(requests) as ClientEventName[]) {
      expect(clientContracts[name].request.safeParse(requests[name]).success, name).toBe(true);
      expect(
        clientContracts[name].request.safeParse({ ...Object(requests[name]), unknown: true })
          .success,
        name,
      ).toBe(false);
      expect(
        clientContracts[name].request.safeParse({ ...Object(requests[name]), requestId: undefined })
          .success,
        name,
      ).toBe(false);
      expect(
        clientContracts[name].ack.parse({
          ok: false,
          requestId,
          serverTime: 0,
          error: internalError(uuid(9)),
        }).ok,
      ).toBe(false);
    }
  });
  it("rejects fake timestamps/scores/correctness and wrong request phase fields", () => {
    const submit = {
      ...member,
      questionIndex: 0,
      questionId: uuid(3),
      submissionId: uuid(4),
      answer: 0,
    };
    for (const patch of [
      { score: 1000 },
      { receivedAt: 1 },
      { clientSentAt: 1 },
      { isCorrect: true },
      { expectedPhaseVersion: 1 },
      { answer: { optionIndex: 0 } },
    ])
      expect(
        clientContracts["player:submit_answer"].request.safeParse({ ...submit, ...patch }).success,
      ).toBe(false);
    expect(clientContracts["host:start_game"].request.safeParse(member).success).toBe(false);
    expect(
      clientContracts["room:sync"].request.safeParse({ ...member, expectedPhaseVersion: 1 })
        .success,
    ).toBe(false);
    expect(clientContracts["host:recover_room"].request.safeParse(member).success).toBe(false);
  });
  it("separates new join from recovery and requires both token and session for recovery", () => {
    expect(
      clientContracts["player:join_room"].request.parse({
        ...member,
        sessionToken: "a".repeat(43),
      }),
    ).toEqual({ ...member, sessionToken: "a".repeat(43) });
    expect(
      clientContracts["player:join_room"].request.safeParse({ requestId, pinCode: "123456" })
        .success,
    ).toBe(false);
    expect(
      clientContracts["player:join_room"].request.safeParse({
        requestId,
        pinCode: "123456",
        sessionToken: "a".repeat(43),
      }).success,
    ).toBe(false);
    expect(
      clientContracts["player:join_room"].request.safeParse({ ...member, sessionToken: "short" })
        .success,
    ).toBe(false);
  });
  it("preserves accepted:true while validating event-specific ACK data", () => {
    const ack = {
      ok: true,
      requestId,
      serverTime: 0,
      data: { accepted: true, submissionId: uuid(4), questionIndex: 0, receivedAt: 0 },
    };
    expect(clientContracts["player:submit_answer"].ack.parse(ack).ok).toBe(true);
    expect(
      clientContracts["player:submit_answer"].ack.safeParse({
        ...ack,
        data: { ...ack.data, score: 1000 },
      }).success,
    ).toBe(false);
    expect(clientContracts["host:start_game"].ack.safeParse(ack).success).toBe(false);
    expect(
      clientContracts["room:time"].ack.safeParse({
        ...ack,
        data: { clientSentAt: 0, serverReceivedAt: 2, serverSentAt: 1 },
      }).success,
    ).toBe(false);
  });
  it("validates handshake version/size and does not accept arbitrary credential fields", () => {
    expect(handshakeSchema.parse({ protocolVersion: 1 })).toEqual({ protocolVersion: 1 });
    expect(handshakeSchema.safeParse({ protocolVersion: 2 }).success).toBe(false);
    expect(
      handshakeSchema.safeParse({ protocolVersion: 1, accessToken: "x".repeat(8192) }).success,
    ).toBe(false);
    expect(
      handshakeSchema.safeParse({ protocolVersion: 1, sessionToken: "a".repeat(43) }).success,
    ).toBe(false);
  });
});
describe("server event envelopes and audience contracts", () => {
  it("defines20 events and keeps protocol/event/session/revision identity mandatory", () => {
    expect(Object.keys(serverEventDataSchemas)).toHaveLength(20);
    const schema = pushEnvelopeSchema(serverEventDataSchemas["room:version"]);
    const envelope = {
      protocolVersion: 1,
      sessionId: uuid(2),
      pinCode: "123456",
      phaseVersion: 1,
      revision: 1,
      serverTime: 0,
      eventId: uuid(5),
      data: { publicRevision: 1 },
    };
    expect(schema.parse(envelope)).toEqual(envelope);
    for (const patch of [
      { protocolVersion: 2 },
      { eventId: undefined },
      { revision: -1 },
      { requestId },
      { data: { publicRevision: 1, secret: "x" } },
    ])
      expect(schema.safeParse({ ...envelope, ...patch }).success).toBe(false);
  });
  it("never exposes finalization/reportId through the player podium schema", () => {
    const finalization = {
      sessionId: uuid(2),
      status: "pending",
      reportId: null,
      retryable: false,
      errorCode: null,
      updatedAt: 0,
    };
    expect(
      hostPodiumDataSchema.parse({ podium: [], finalization, reportId: null }).reportId,
    ).toBeNull();
    expect(playerPodiumDataSchema.parse({ podium: [], result: null }).result).toBeNull();
    expect(
      playerPodiumDataSchema.safeParse({ podium: [], result: null, finalization, reportId: null })
        .success,
    ).toBe(false);
    expect("report:status_changed" in playerEventDataSchemas).toBe(false);
    expect("game:answer_count_updated" in playerEventDataSchemas).toBe(false);
    expect(
      hostPodiumDataSchema.safeParse({ podium: [], finalization, reportId: uuid(2) }).success,
    ).toBe(false);
  });
  it("rejects timing or required-answer counts that contradict the server contract", () => {
    expect(
      serverEventDataSchemas["game:countdown"].safeParse({
        durationSec: 3,
        quizTitle: "Quiz",
        totalQuestions: 1,
        phaseStartedAt: 100,
        phaseEndsAt: 3100,
      }).success,
    ).toBe(true);
    expect(
      serverEventDataSchemas["game:countdown"].safeParse({
        durationSec: 3,
        quizTitle: "Quiz",
        totalQuestions: 1,
        phaseStartedAt: 100,
        phaseEndsAt: 3000,
      }).success,
    ).toBe(false);
    expect(
      serverEventDataSchemas["game:answer_count_updated"].safeParse({
        answeredCount: 3,
        totalPlayers: 2,
        optionalAnswerCount: 0,
      }).success,
    ).toBe(false);
  });
});
