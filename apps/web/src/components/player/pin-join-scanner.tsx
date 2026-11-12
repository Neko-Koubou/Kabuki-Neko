"use client";
/**
 * S14 / F11 guest join: PIN entry, QR scan and deep links (Design §4.6; SA §5.2; US-08/12/21;
 * TASK-151). Players need no account.
 *
 * - One text field (`inputmode=numeric`, six ASCII digits). Typing or pasting keeps leading zeros,
 *   and pasted separators are ignored ("000 123" → "000123").
 * - `?pin=` deep links fill the field and check the PIN exactly once; the camera scanner (M02)
 *   does the same with a recognized join QR. Nothing ever joins before the full identity (M01)
 *   is complete.
 * - The check (`player:check_pin` over an anonymous player socket) leads to:
 *   - the identity step for an open room;
 *   - "No game found with that PIN" (never polled again);
 *   - locked / full / already started guidance;
 *   - the server's retry-after for rate limits (the button waits until then);
 *   - an offline/unknown result with Try again.
 * - Recovery: credentials stored for this PIN are bound to their session id. The player can rejoin
 *   (even while the game is running). If the server no longer accepts them (session gone,
 *   replaced, kicked), they are cleared and the player joins anew.
 * - After a successful join the player is sent to the game screen (`/play/<pin>`).
 * States: loading (checking, input disabled), empty (enter the 6-digit PIN), ideal (game found →
 * identity), partial (locked / full / in progress / wait) and error (offline or failed → retry).
 */
import { QrCode } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { DisplayMode } from "@kabuki-neko/shared/constants/game";
import {
  AvatarCustomizer,
  type DiceAudio,
  type PlayerEmitter,
} from "@/components/player/avatar-customizer";
import { QrScanner } from "@/components/player/qr-scanner";
import { ActionButton } from "@/components/ui/action-button";
import {
  clearPlayerSession,
  findPlayerSessionByPin,
  savePlayerSession,
  type PlayerSessionRecord,
  type RecordStorage,
} from "@/hooks/use-session-recovery";
import type { AvatarStyleLoader } from "@/lib/avatar";
import { configuredAppOrigin } from "@/lib/qr";
import { createGameSocket, type GameSocket } from "@/lib/socket-client";
import { useLocale } from "@/providers/locale-provider";

/** Six ASCII digits taken from typed or pasted text (other characters dropped). */
export function normalizePin(input: string): string {
  return input.replace(/[^0-9]/gu, "").slice(0, 6);
}

/** True for a complete PIN. */
function complete(pin: string): boolean {
  return /^[0-9]{6}$/u.test(pin);
}

/** Recovery failures after which stored credentials are useless. */
const DEAD_SESSION = new Set([
  "INVALID_SESSION_TOKEN",
  "PLAYER_KICKED",
  "SESSION_REPLACED",
  "ROOM_NOT_FOUND",
  "ROOM_EXPIRED",
  "ROOM_LOST",
]);

/** Socket used by the join page (injectable in tests). */
export type JoinSocket = PlayerEmitter & {
  connect?: () => void;
  disconnect?: () => void;
  /** False once the transport dropped (the real client); absent on test doubles. */
  readonly connected?: boolean;
  onLifecycle?: GameSocket["onLifecycle"];
};

/** How long a command waits for a dropped join socket to reconnect before sending anyway. */
export const JOIN_RECONNECT_TIMEOUT_MS = 5_000;

/**
 * Emitter that reconnects the page's anonymous socket before each command (code review MJ-23).
 * The server drops anonymous sockets after 120 s, and the client is created with
 * `reconnection: false`, so a student who waits on /join for the host's PIN (or spends long on
 * the identity step) would otherwise send into a dead socket and time out forever. When the
 * socket reports `connected === false`, it connects again and waits for `connect` (or
 * `connect_error`, or the timeout) before emitting; a live socket is used directly.
 */
export function reconnectingEmitter(
  socket: JoinSocket,
  timeoutMs = JOIN_RECONNECT_TIMEOUT_MS,
): PlayerEmitter {
  /** Resolves once the socket is connected again (or the attempt failed or timed out). */
  const ready = async () => {
    const { connect, onLifecycle } = socket;
    if (socket.connected !== false || !connect || !onLifecycle) return;
    await new Promise<void>((resolve) => {
      const unsubscribers: (() => void)[] = [];
      const done = () => {
        clearTimeout(timer);
        for (const unsubscribe of unsubscribers) unsubscribe();
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      unsubscribers.push(onLifecycle("connect", done), onLifecycle("connect_error", done));
      connect();
    });
  };
  return {
    emit: (async (event, payload) => {
      await ready();
      return socket.emit(event, payload);
    }) as PlayerEmitter["emit"],
  };
}

/** Join step. */
type Step =
  | { kind: "pin" }
  | { kind: "recover"; pin: string; record: PlayerSessionRecord; room: RoomInfo | null }
  | { kind: "identity"; pin: string; room: RoomInfo }
  | { kind: "done" };

/** Room facts from the PIN check. */
interface RoomInfo {
  friendlyNicknames: boolean;
  displayMode: DisplayMode;
}

/** Check outcome message. */
type Problem = {
  tone: "warning" | "error";
  key: string;
  values?: Record<string, number>;
  retry: boolean;
} | null;

/** Props of {@link PinJoinScanner}. */
export interface PinJoinScannerProps {
  /** PIN from a `?pin=` deep link (checked once). */
  initialPin?: string | null;
  /** Called with the game route after joining. */
  navigate: (href: string) => void;
  /** Player socket (defaults to an anonymous `/game` connection). */
  socket?: JoinSocket;
  /** Accepted QR origin (defaults to the configured app origin). */
  allowedOrigin?: string;
  storage?: RecordStorage | null;
  audio?: DiceAudio;
  loader?: AvatarStyleLoader;
}

/** The S14 join flow. */
export function PinJoinScanner({
  initialPin = null,
  navigate,
  socket: provided,
  allowedOrigin,
  storage,
  audio,
  loader,
}: PinJoinScannerProps) {
  const { t, ensureNamespaces } = useLocale();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [socket] = useState<JoinSocket>(
    () =>
      provided ??
      createGameSocket({
        url: process.env.NEXT_PUBLIC_WS_URL ?? "http://localhost:3001",
        role: "player",
      }),
  );
  const emitter = useMemo(() => reconnectingEmitter(socket), [socket]);
  const [pin, setPin] = useState(() => normalizePin(initialPin ?? ""));
  const [step, setStep] = useState<Step>({ kind: "pin" });
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [waitUntil, setWaitUntil] = useState(0);
  const [scannerOpen, setScannerOpen] = useState(false);
  const deepLinked = useRef(false);
  /** Where focus goes when the scanner closes (the PIN field after manual entry). */
  const scannerReturn = useRef<HTMLElement | null>(null);
  const store = storage === undefined ? undefined : storage;

  useEffect(() => {
    void ensureNamespaces(["player", "validation"]);
  }, [ensureNamespaces]);

  // One anonymous connection for the page.
  useEffect(() => {
    socket.connect?.();
    return () => socket.disconnect?.();
  }, [socket]);

  // A rate limit re-enables the button when the server's wait is over.
  useEffect(() => {
    if (waitUntil <= Date.now()) return;
    const timer = setTimeout(() => setWaitUntil(0), waitUntil - Date.now());
    return () => clearTimeout(timer);
  }, [waitUntil]);

  /** Checks a PIN once; never polls a wrong PIN. */
  const check = useCallback(
    async (value: string) => {
      if (!complete(value)) {
        setProblem({ tone: "warning", key: "player.join.pinHelp", retry: false });
        inputRef.current?.focus();
        return;
      }
      setChecking(true);
      setProblem(null);
      const result = await emitter.emit("player:check_pin", { pinCode: value });
      setChecking(false);
      const stored = findPlayerSessionByPin(value, store);
      if (result.status === "ok") {
        const room = {
          friendlyNicknames: result.data.friendlyNicknames,
          displayMode: result.data.displayMode,
        };
        setStep(
          stored
            ? { kind: "recover", pin: value, record: stored, room }
            : { kind: "identity", pin: value, room },
        );
        return;
      }
      if (result.status === "unknown") {
        setProblem({ tone: "error", key: "player.inventory.s14.error", retry: true });
        return;
      }
      const code = result.error.errorCode;
      if (code === "GAME_IN_PROGRESS" && stored) {
        setStep({ kind: "recover", pin: value, record: stored, room: null });
        return;
      }
      if (code === "RATE_LIMITED") {
        const ms =
          typeof result.error.params.retryAfterMs === "number"
            ? result.error.params.retryAfterMs
            : 1000;
        setWaitUntil(Date.now() + ms);
        setProblem({
          tone: "warning",
          key: "player.join.retryAfter",
          values: { seconds: Math.ceil(ms / 1000) },
          retry: false,
        });
        return;
      }
      const keys: Record<string, string> = {
        ROOM_NOT_FOUND: "player.join.invalidPin",
        ROOM_LOCKED: "player.join.locked",
        ROOM_FULL: "player.join.full",
        GAME_IN_PROGRESS: "player.join.inProgress",
      };
      setProblem({
        tone: keys[code] ? "warning" : "error",
        key: keys[code] ?? "player.inventory.s14.error",
        retry: !keys[code],
      });
    },
    [emitter, store],
  );

  // A deep link checks its PIN exactly once.
  useEffect(() => {
    if (deepLinked.current || !initialPin) return;
    deepLinked.current = true;
    const value = normalizePin(initialPin);
    setPin(value);
    void check(value);
  }, [initialPin, check]);

  /** Rejoins with stored credentials; dead credentials are cleared and a new join follows. */
  const recover = async (target: Extract<Step, { kind: "recover" }>) => {
    setChecking(true);
    setProblem(null);
    const result = await emitter.emit("player:join_room", {
      requestId: crypto.randomUUID(),
      sessionId: target.record.sessionId,
      pinCode: target.pin,
      sessionToken: target.record.sessionToken,
    });
    setChecking(false);
    if (result.status === "ok") {
      savePlayerSession(
        {
          sessionId: result.data.sessionId,
          playerId: result.data.playerId,
          sessionToken: result.data.sessionToken,
          pinCode: target.pin,
        },
        store,
      );
      setStep({ kind: "done" });
      navigate(`/play/${target.pin}`);
      return;
    }
    if (result.status === "error" && DEAD_SESSION.has(result.error.errorCode)) {
      clearPlayerSession(target.record.sessionId, store);
      if (target.room) setStep({ kind: "identity", pin: target.pin, room: target.room });
      else {
        setStep({ kind: "pin" });
        setProblem({ tone: "warning", key: "player.join.inProgress", retry: false });
      }
      return;
    }
    setProblem({ tone: "error", key: "player.inventory.s14.error", retry: false });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (checking || waitUntil > Date.now()) return;
    void check(pin);
  };

  if (step.kind === "identity")
    return (
      <AvatarCustomizer
        mode="join"
        pinCode={step.pin}
        friendlyNicknames={step.room.friendlyNicknames}
        socket={emitter}
        onJoined={() => {
          setStep({ kind: "done" });
          navigate(`/play/${step.pin}`);
        }}
        onBack={() => setStep({ kind: "pin" })}
        {...(audio ? { audio } : {})}
        {...(store !== undefined ? { storage: store } : {})}
        {...(loader ? { loader } : {})}
      />
    );

  if (step.kind === "recover")
    return (
      <section
        aria-labelledby={`${inputId}-recover`}
        className="mx-auto flex w-full max-w-[440px] flex-col gap-4"
      >
        <h1 id={`${inputId}-recover`} className="text-title font-bold">
          {t("player.join.recoverSession")}
        </h1>
        <p className="font-mono text-title-sm tracking-[0.2em] tabular-nums">{step.pin}</p>
        {problem && (
          <p role="alert" className="text-small text-danger">
            {t(problem.key, problem.values)}
          </p>
        )}
        <ActionButton
          size="lg"
          pending={checking}
          label={t("player.join.recoverSession")}
          onPress={() => void recover(step)}
        />
        {step.room && (
          <ActionButton
            variant="secondary"
            label={t("player.avatar.join")}
            onPress={() =>
              step.room && setStep({ kind: "identity", pin: step.pin, room: step.room })
            }
          />
        )}
      </section>
    );

  if (step.kind === "done")
    return (
      <p role="status" className="mx-auto w-full max-w-[440px] text-small">
        {t("player.join.joined")}
      </p>
    );

  const waiting = waitUntil > Date.now();
  return (
    <section
      aria-labelledby={`${inputId}-title`}
      className="mx-auto flex w-full max-w-[440px] flex-col gap-4"
    >
      <h1 id={`${inputId}-title`} className="text-title font-bold">
        {t("player.join.title")}
      </h1>
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <label htmlFor={inputId} className="text-label font-semibold">
          {t("player.join.pin")}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          name="pin"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={12}
          autoFocus={!initialPin}
          disabled={checking}
          aria-describedby={`${inputId}-help`}
          aria-invalid={problem?.key === "player.join.invalidPin" || undefined}
          value={pin}
          onChange={(event) => {
            setPin(normalizePin(event.target.value));
            if (problem && !waiting) setProblem(null);
          }}
          className="min-h-14 w-full rounded-md border border-input bg-background px-4 text-center font-mono text-title tracking-[0.3em] tabular-nums"
        />
        <p id={`${inputId}-help`} className="text-small text-muted-foreground">
          {pin === "" ? t("player.inventory.s14.empty") : t("player.join.pinHelp")}
        </p>
        <ActionButton
          type="submit"
          size="lg"
          pending={checking}
          disabled={waiting}
          {...(waiting && problem ? { disabledReason: t(problem.key, problem.values) } : {})}
          label={t("player.join.join")}
        />
      </form>
      <ActionButton
        variant="secondary"
        icon={<QrCode />}
        label={t("player.join.scanQr")}
        onPress={() => {
          scannerReturn.current = null;
          setScannerOpen(true);
        }}
      />
      <p role="status" aria-live="polite" className="text-small empty:hidden">
        {checking ? t("player.join.checking") : ""}
      </p>
      {problem && (
        <div
          role="alert"
          className={`flex flex-col items-start gap-2 rounded-md border p-3 text-small ${
            problem.tone === "error"
              ? "border-danger bg-danger-surface text-danger"
              : "border-warning bg-warning-surface text-warning"
          }`}
        >
          <p>{t(problem.key, problem.values)}</p>
          {problem.retry && (
            <ActionButton
              variant="secondary"
              label={t("common.actions.retry")}
              onPress={() => void check(pin)}
            />
          )}
        </div>
      )}
      <QrScanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        allowedOrigin={allowedOrigin ?? configuredAppOrigin() ?? ""}
        onPin={(value) => {
          setScannerOpen(false);
          setPin(value);
          void check(value);
        }}
        returnFocus={scannerReturn}
        onManualEntry={() => {
          scannerReturn.current = inputRef.current;
          setScannerOpen(false);
        }}
      />
    </section>
  );
}
