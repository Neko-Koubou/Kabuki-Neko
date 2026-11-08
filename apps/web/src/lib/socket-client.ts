/**
 * Typed Socket.IO client for the `/game` namespace (SA §5.1–5.2; US-07/08/10/12; TASK-128).
 *
 * - Connects to `<wsUrl>/game` on path `/socket.io` (websocket, then polling) with the handshake
 *   `{ protocolVersion: 1, accessToken? }`; the token is read fresh on every (re)connect. Automatic
 *   Socket.IO reconnection is off: `use-socket` applies the SA backoff instead.
 * - `emit` validates the request against the shared contract, adds a `requestId`, and waits at most
 *   5 s for the ACK. A late or missing ACK resolves to `{ status: "unknown" }` — never success and
 *   never an automatic re-send — so callers sync or look the operation up. Valid ACKs are parsed
 *   with the contract's ACK schema (`ok` data or the shared error envelope).
 * - `on` validates each push envelope with the role's event schemas before the handler sees it;
 *   malformed pushes are dropped.
 * - `backoffDelay` implements 1/2/4/8/16/30 s with up to 20 % jitter, never shorter than a
 *   server-provided `retryAfterMs`.
 */
import { io, type Socket } from "socket.io-client";
import { z } from "zod";
import type { ErrorEnvelope } from "@kabuki-neko/shared/errors";
import {
  GAME_NAMESPACE,
  PROTOCOL_VERSION,
  SOCKET_IO_PATH,
  clientContracts,
  hostEventDataSchemas,
  playerEventDataSchemas,
  pushEnvelopeSchema,
  type ClientAck,
  type ClientEventName,
  type ClientRequest,
  type PushEnvelope,
} from "@kabuki-neko/shared/socket-events";

/** ACK deadline (SA §5.1). */
export const ACK_TIMEOUT_MS = 5_000;
/** Reconnect backoff steps in seconds (SA §5.1). */
export const BACKOFF_STEPS_SEC = [1, 2, 4, 8, 16, 30] as const;

/** Minimal socket surface used by the client (the real Socket.IO socket, or a test double). */
export interface SocketLike {
  connected: boolean;
  connect(): unknown;
  disconnect(): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  emit(event: string, payload: unknown, ack: (response: unknown) => void): unknown;
}

/** Outcome of an emitted command. */
export type EmitResult<E extends ClientEventName> =
  | {
      status: "ok";
      requestId: string;
      serverTime: number;
      data: Extract<ClientAck<E>, { ok: true }>["data"];
    }
  | { status: "error"; requestId: string; error: ErrorEnvelope }
  | { status: "unknown"; requestId: string };

/** `Omit` applied to each member of a union (requests such as join have several shapes). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Request payload without the generated `requestId` (it may still be supplied for retries). */
export type EmitPayload<E extends ClientEventName> = DistributiveOmit<
  ClientRequest<E>,
  "requestId"
> & {
  requestId?: string;
};

/** Which push schemas apply. */
export type SocketRole = "host" | "player";

/** Client options. */
export interface GameSocketOptions {
  /** Public WebSocket origin (`NEXT_PUBLIC_WS_URL`). */
  url: string;
  role: SocketRole;
  getAccessToken?: () => string | null;
  /** Socket factory (tests); defaults to Socket.IO. */
  createSocket?: (url: string, options: Record<string, unknown>) => SocketLike;
  ackTimeoutMs?: number;
}

/** Reconnect delay for attempt `n` (0-based): steps + up to 20 % jitter, at least `retryAfterMs`. */
export function backoffDelay(
  attempt: number,
  retryAfterMs: number | null = null,
  random: () => number = Math.random,
): number {
  const step = BACKOFF_STEPS_SEC[Math.min(attempt, BACKOFF_STEPS_SEC.length - 1)] ?? 30;
  const delay = Math.round(step * 1000 * (1 + random() * 0.2));
  return Math.max(delay, retryAfterMs ?? 0);
}

/** Creates the typed `/game` client (not connected yet). */
export function createGameSocket(options: GameSocketOptions) {
  const ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_MS;
  const factory =
    options.createSocket ??
    ((url: string, socketOptions: Record<string, unknown>) =>
      io(url, socketOptions) as unknown as SocketLike);
  const socket = factory(`${options.url.replace(/\/$/u, "")}${GAME_NAMESPACE}`, {
    path: SOCKET_IO_PATH,
    transports: ["websocket", "polling"],
    autoConnect: false,
    reconnection: false,
    // Called on every (re)connect, so a refreshed access token is always used.
    auth: (callback: (data: Record<string, unknown>) => void) => {
      const accessToken = options.getAccessToken?.();
      callback(
        accessToken
          ? { protocolVersion: PROTOCOL_VERSION, accessToken }
          : { protocolVersion: PROTOCOL_VERSION },
      );
    },
  });
  const schemas = options.role === "host" ? hostEventDataSchemas : playerEventDataSchemas;

  /** Sends a command and resolves its ACK, an error envelope, or `unknown` after the deadline. */
  function emit<E extends ClientEventName>(
    event: E,
    payload: EmitPayload<E>,
  ): Promise<EmitResult<E>> {
    const requestId = payload.requestId ?? crypto.randomUUID();
    const contract = clientContracts[event];
    const request = contract.request.safeParse({ ...payload, requestId });
    if (!request.success) throw new Error(`invalid ${event} request`);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolve({ status: "unknown", requestId });
      }, ackTimeoutMs);
      socket.emit(event, request.data, (response: unknown) => {
        if (settled) return; // a late ACK is ignored; the caller already synced
        settled = true;
        clearTimeout(timer);
        const ack = (contract.ack as z.ZodType).safeParse(response);
        if (!ack.success) {
          resolve({ status: "unknown", requestId });
          return;
        }
        const value = ack.data as {
          ok: boolean;
          requestId: string;
          serverTime: number;
          data?: unknown;
          error?: ErrorEnvelope;
        };
        resolve(
          value.ok
            ? ({
                status: "ok",
                requestId,
                serverTime: value.serverTime,
                data: value.data,
              } as EmitResult<E>)
            : { status: "error", requestId, error: value.error as ErrorEnvelope },
        );
      });
    });
  }

  /** Subscribes to a server push; only schema-valid envelopes reach the handler. */
  function on(event: string, handler: (envelope: PushEnvelope<unknown>) => void): () => void {
    const schema = (schemas as Record<string, z.ZodType>)[event];
    const listener = (raw: unknown) => {
      if (!schema) return;
      const parsed = pushEnvelopeSchema(schema).safeParse(raw);
      if (parsed.success) handler(parsed.data as PushEnvelope<unknown>);
    };
    socket.on(event, listener as never);
    return () => {
      socket.off(event, listener as never);
    };
  }

  /** Subscribes to connection lifecycle events. */
  function onLifecycle(
    event: "connect" | "disconnect" | "connect_error",
    handler: (detail?: unknown) => void,
  ): () => void {
    socket.on(event, handler as never);
    return () => {
      socket.off(event, handler as never);
    };
  }

  return {
    emit,
    on,
    onLifecycle,
    connect: () => socket.connect(),
    disconnect: () => socket.disconnect(),
    get connected() {
      return socket.connected;
    },
    /** The underlying socket (diagnostics/tests). */
    raw: socket,
  };
}

/** The typed client type. */
export type GameSocket = ReturnType<typeof createGameSocket>;

/** Re-exported for typed handlers. */
export type { Socket };
