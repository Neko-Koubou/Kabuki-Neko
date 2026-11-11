"use client";
/**
 * M01 / F12 player identity: nickname and DiceBear avatar for guests who join without an account
 * (Design §4.6, §4.9 M01, §7; SA §5.2; US-08/09/12/18/21; TASK-150).
 *
 * Join mode (after a valid PIN):
 * - Avatar: a large preview, six styles (2-column radio grid) and a dice button. The dice picks a
 *   new local seed and plays the "nekoPop" cue through the audio manager singleton (the user
 *   gesture unlocks audio; presses are throttled to one cue per 150 ms; no new sound object per
 *   render).
 * - A successful new join (not a recovery) plays one "nekoPop" for the player's own join,
 *   deduplicated per player id.
 * - Nickname: up to 15 user-perceived characters (shared `nicknameSchema`, any script or emoji).
 *   In rooms with friendly nicknames there is no free field: the server picks a safe name
 *   (`player:request_friendly_name`) and returns a ticket that the join sends back.
 * - "Join game" sends `player:join_room` with the complete identity, only once at a time. A lost
 *   ACK is retried with the same `requestId` (the server de-duplicates), so a retry never creates a
 *   second player. A definitive error starts a new attempt id.
 * - Errors keep every field: a taken or forbidden nickname is a field error; a full, locked,
 *   started or vanished room explains why and offers going back to the PIN.
 * - Recovery: with stored room credentials the join is a recovery (session token). Nickname
 *   edits are not sent, so the server keeps the original nickname.
 * - The room credentials from the ACK are stored (room-scoped token only, never an account).
 *
 * Edit mode (lobby): avatar only, the nickname stays. "Save avatar" sends
 * `player:update_avatar`. A rejected or unconfirmed change reverts the preview to the saved
 * avatar. Outside the lobby the avatar cannot be changed.
 *
 * States: loading (picking a name / joining / saving), empty (no nickname yet), ideal (ready to
 * join), partial (nickname taken or not allowed; mixed scripts may not render everywhere) and
 * error (could not join or save; details kept).
 */
import { Dices } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AVATAR_STYLES, type GamePhase } from "@kabuki-neko/shared/constants/game";
import { TEXT_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { nicknameSchema } from "@kabuki-neko/shared/unicode";
import { AvatarIllustration } from "@/components/ui/avatar-illustration";
import { ActionButton } from "@/components/ui/action-button";
import { FormField } from "@/components/ui/form-field";
import { apiErrorMessageKey } from "@/lib/api-client";
import { getAudioManager } from "@/lib/audio-manager";
import {
  defaultAvatar,
  randomAvatarSeed,
  type Avatar,
  type AvatarStyle,
  type AvatarStyleLoader,
} from "@/lib/avatar";
import type { EmitResult, GameSocket } from "@/lib/socket-client";
import {
  savePlayerSession,
  type PlayerSessionRecord,
  type RecordStorage,
} from "@/hooks/use-session-recovery";
import { useLocale } from "@/providers/locale-provider";

/** Minimum time between two dice sounds (ms). */
export const DICE_SOUND_THROTTLE_MS = 150;

/** Audio surface used for the dice cue (injectable in tests). */
export interface DiceAudio {
  playSfx(id: "nekoPop", options?: { eventId?: string }): Promise<boolean>;
  unlock(): Promise<boolean>;
}

/** Socket surface: typed `emit` only. */
export type PlayerEmitter = Pick<GameSocket, "emit">;

/** DiceBear style names (proper nouns, not translated). */
export function styleName(style: AvatarStyle): string {
  return style
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Message key for a nickname problem, or null when the nickname is valid. */
export function nicknameProblem(nickname: string): string | null {
  if (nickname.trim() === "") return "validation.errors.required";
  return nicknameSchema.safeParse(nickname).success ? null : "validation.errors.nicknameInvalid";
}

/** Join failures that mean the room itself changed (go back to the PIN). */
const ROOM_CODES = new Set([
  "ROOM_FULL",
  "ROOM_LOCKED",
  "GAME_IN_PROGRESS",
  "ROOM_NOT_FOUND",
  "ROOM_EXPIRED",
  "ROOM_LOST",
]);

/** Successful join data. */
export type JoinedRoom = Extract<EmitResult<"player:join_room">, { status: "ok" }>["data"];

/** Avatar style grid plus dice, shared by both modes. */
function AvatarPicker({
  avatar,
  nickname,
  disabled,
  onChange,
  onDice,
  loader,
}: {
  avatar: Avatar;
  nickname: string;
  disabled: boolean;
  onChange: (avatar: Avatar) => void;
  onDice: () => void;
  loader?: AvatarStyleLoader;
}) {
  const { t } = useLocale();
  const name = useId();
  return (
    <div className="flex flex-col items-center gap-4">
      <AvatarIllustration
        avatar={avatar}
        nickname={nickname}
        size={128}
        decorative
        {...(loader ? { loader } : {})}
      />
      <fieldset className="w-full" disabled={disabled}>
        <legend className="mb-2 text-label font-semibold">{t("player.avatar.style")}</legend>
        <div className="grid grid-cols-2 gap-2">
          {AVATAR_STYLES.map((style) => (
            <label
              key={style}
              className="flex min-h-14 cursor-pointer items-center gap-2 rounded-md border border-border p-2 has-[:checked]:border-primary has-[:checked]:bg-subtle has-[:focus-visible]:outline has-[:focus-visible]:outline-2"
            >
              <input
                type="radio"
                name={name}
                value={style}
                checked={avatar.style === style}
                onChange={() => onChange({ ...avatar, style })}
                className="sr-only"
              />
              <AvatarIllustration
                avatar={{ style, seed: avatar.seed }}
                size={40}
                decorative
                {...(loader ? { loader } : {})}
              />
              <span className="min-w-0 text-small break-words">{styleName(style)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <ActionButton
        variant="secondary"
        icon={<Dices />}
        disabled={disabled}
        label={t("player.avatar.randomize")}
        onPress={onDice}
      />
    </div>
  );
}

/** Dice handler: new seed + throttled nekoPop through the shared manager. */
function useDice(
  audio: DiceAudio | undefined,
  setAvatar: (update: (avatar: Avatar) => Avatar) => void,
) {
  const lastSound = useRef(Number.NEGATIVE_INFINITY);
  const unlocked = useRef(false);
  return useCallback(() => {
    setAvatar((current) => ({ ...current, seed: randomAvatarSeed() }));
    const player = audio ?? getAudioManager();
    const now = Date.now();
    if (now - lastSound.current < DICE_SOUND_THROTTLE_MS) return;
    lastSound.current = now;
    // This press is the user gesture that may unlock audio.
    const unlock = unlocked.current ? Promise.resolve(true) : player.unlock().catch(() => false);
    unlocked.current = true;
    void unlock.then(() => player.playSfx("nekoPop").catch(() => false));
  }, [audio, setAvatar]);
}

/** Props of the join customizer. */
export interface JoinCustomizerProps {
  mode: "join";
  pinCode: string;
  /** Room assigns safe random nicknames (no free text). */
  friendlyNicknames: boolean;
  socket: PlayerEmitter;
  /** Stored room credentials: the join recovers that player. */
  recovery?: PlayerSessionRecord | null;
  onJoined: (room: JoinedRoom) => void;
  /** Back to the PIN entry (room changed). */
  onBack?: () => void;
  audio?: DiceAudio;
  storage?: RecordStorage | null;
  loader?: AvatarStyleLoader;
}

/** Props of the lobby avatar editor. */
export interface EditCustomizerProps {
  mode: "edit";
  phase: GamePhase | null;
  sessionId: string;
  pinCode: string;
  nickname: string;
  avatar: Avatar;
  socket: PlayerEmitter;
  onSaved: (avatar: Avatar) => void;
  audio?: DiceAudio;
  loader?: AvatarStyleLoader;
}

/** Props of {@link AvatarCustomizer}. */
export type AvatarCustomizerProps = JoinCustomizerProps | EditCustomizerProps;

/** M01 / F12 customizer (join or lobby avatar edit). */
export function AvatarCustomizer(props: AvatarCustomizerProps) {
  const { ensureNamespaces } = useLocale();
  useEffect(() => {
    void ensureNamespaces(["player", "validation"]);
  }, [ensureNamespaces]);
  return props.mode === "join" ? <JoinCustomizer {...props} /> : <EditCustomizer {...props} />;
}

/** Join form. */
function JoinCustomizer({
  pinCode,
  friendlyNicknames,
  socket,
  recovery = null,
  onJoined,
  onBack,
  audio,
  storage,
  loader,
}: JoinCustomizerProps) {
  const { t } = useLocale();
  const nicknameId = useId();
  const [avatar, setAvatar] = useState<Avatar>(() => ({
    ...defaultAvatar(),
    seed: randomAvatarSeed(),
  }));
  const [nickname, setNickname] = useState("");
  const [ticket, setTicket] = useState<{ value: string; expiresAt: number } | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "error" | "warning";
    text: string;
    back: boolean;
  } | null>(null);
  const [busy, setBusy] = useState<"name" | "join" | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const dice = useDice(audio, setAvatar);

  /** Asks the server for a safe random nickname (friendly rooms). */
  const requestName = async () => {
    if (busy) return;
    setBusy("name");
    setNotice(null);
    const result = await socket.emit("player:request_friendly_name", { pinCode });
    setBusy(null);
    if (result.status === "ok") {
      setNickname(result.data.nickname);
      setTicket({ value: result.data.friendlyNameTicket, expiresAt: result.data.expiresAt });
      setFieldError(null);
    } else
      setNotice({
        tone: "error",
        text:
          result.status === "error"
            ? t(apiErrorMessageKey(result.error.errorCode))
            : t("player.inventory.m01.error"),
        back: result.status === "error" && ROOM_CODES.has(result.error.errorCode),
      });
  };

  /** Sends the complete identity once; a lost ACK keeps the same request id. */
  const join = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!recovery) {
      const problem = friendlyNicknames
        ? ticket
          ? null
          : "validation.errors.required"
        : nicknameProblem(nickname);
      if (problem) {
        setFieldError(problem);
        return;
      }
    }
    setBusy("join");
    setNotice(null);
    setFieldError(null);
    const payload = recovery
      ? {
          requestId: requestId.current,
          sessionId: recovery.sessionId,
          pinCode,
          sessionToken: recovery.sessionToken,
          avatar,
        }
      : {
          requestId: requestId.current,
          pinCode,
          nickname: nickname.trim(),
          avatar,
          ...(friendlyNicknames && ticket ? { friendlyNameTicket: ticket.value } : {}),
        };
    const result = await socket.emit("player:join_room", payload);
    setBusy(null);
    if (result.status === "ok") {
      savePlayerSession(
        {
          sessionId: result.data.sessionId,
          playerId: result.data.playerId,
          sessionToken: result.data.sessionToken,
          pinCode,
        },
        storage === undefined ? undefined : storage,
      );
      requestId.current = crypto.randomUUID();
      // Own successful (new) join: one nekoPop, deduplicated per player.
      if (!result.data.recovered) {
        const player = audio ?? getAudioManager();
        void player
          .unlock()
          .catch(() => false)
          .then(() => player.playSfx("nekoPop", { eventId: `ownJoin:${result.data.playerId}` }))
          .catch(() => false);
      }
      onJoined(result.data);
      return;
    }
    if (result.status === "unknown") {
      // Same request id on the next press: the server answers with the original outcome.
      setNotice({ tone: "error", text: t("player.inventory.m01.error"), back: false });
      return;
    }
    requestId.current = crypto.randomUUID();
    const code = result.error.errorCode;
    if (code === "NICKNAME_TAKEN") setFieldError("player.avatar.taken");
    else if (code === "NICKNAME_FORBIDDEN" || code === "NICKNAME_INVALID")
      setFieldError("player.avatar.forbidden");
    else
      setNotice({
        tone: "error",
        text: `${t("player.inventory.m01.error")} ${t(apiErrorMessageKey(code))}`,
        back: ROOM_CODES.has(code),
      });
    if (code === "NICKNAME_TAKEN" || code === "NICKNAME_FORBIDDEN") setTicket(null);
  };

  const status =
    busy === "name"
      ? t("player.inventory.f12.loading")
      : busy === "join"
        ? t("player.inventory.m01.loading")
        : "";
  const ready =
    recovery !== null || (friendlyNicknames ? ticket !== null : nicknameProblem(nickname) === null);

  return (
    <form
      noValidate
      onSubmit={(event) => void join(event)}
      className="mx-auto flex w-full max-w-[440px] flex-col gap-5"
    >
      <div>
        <h1 className="text-title font-bold">{t("player.avatar.title")}</h1>
        <p className="text-small text-muted-foreground">
          {ready ? t("player.inventory.m01.ideal") : t("player.inventory.m01.empty")}
        </p>
      </div>
      <AvatarPicker
        avatar={avatar}
        nickname={nickname}
        disabled={busy === "join"}
        onChange={setAvatar}
        onDice={dice}
        {...(loader ? { loader } : {})}
      />
      {recovery ? null : friendlyNicknames ? (
        <div className="flex flex-col gap-2">
          <p className="text-label font-semibold">{t("player.avatar.nickname")}</p>
          <p
            aria-live="polite"
            className="min-h-11 rounded-md border border-border bg-subtle px-3 py-2 text-body break-words"
          >
            {nickname || t("player.inventory.f12.empty")}
          </p>
          <ActionButton
            variant="secondary"
            pending={busy === "name"}
            disabled={busy === "join"}
            label={t("player.avatar.randomNickname")}
            onPress={() => void requestName()}
          />
          {fieldError && (
            <p role="alert" className="text-small text-danger">
              {t(fieldError)}
            </p>
          )}
        </div>
      ) : (
        <FormField
          id={nicknameId}
          name="nickname"
          label={t("player.avatar.nickname")}
          help={t("player.avatar.nicknameHelp")}
          required
          autoComplete="nickname"
          limit={TEXT_LIMITS.nickname}
          disabled={busy === "join"}
          value={nickname}
          onChange={(value) => {
            setNickname(value);
            if (fieldError) setFieldError(null);
          }}
          error={fieldError ? t(fieldError) : undefined}
        />
      )}
      {notice && (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-md border border-danger bg-danger-surface p-3 text-small text-danger"
        >
          <p>{notice.text}</p>
          {notice.back && onBack && (
            <ActionButton variant="secondary" label={t("common.actions.back")} onPress={onBack} />
          )}
        </div>
      )}
      {fieldError === "player.avatar.taken" && (
        <p role="note" className="text-small text-warning">
          {t("player.inventory.f12.partial")}
        </p>
      )}
      <ActionButton
        type="submit"
        size="lg"
        pending={busy === "join"}
        label={t("player.avatar.join")}
      />
      <p role="status" aria-live="polite" className="text-small empty:hidden">
        {status}
      </p>
    </form>
  );
}

/** Lobby avatar-only editor. */
function EditCustomizer({
  phase,
  sessionId,
  pinCode,
  nickname,
  avatar: saved,
  socket,
  onSaved,
  audio,
  loader,
}: EditCustomizerProps) {
  const { t } = useLocale();
  const [avatar, setAvatar] = useState<Avatar>(saved);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const dice = useDice(audio, setAvatar);
  const inLobby = phase === "LOBBY";

  // A new saved avatar (from the server) replaces the preview.
  useEffect(() => {
    setAvatar(saved);
  }, [saved]);

  /** Sends the avatar; anything but a confirmed save reverts the preview. */
  const save = async () => {
    if (busy || !inLobby) return;
    setBusy(true);
    setFailed(false);
    const result = await socket.emit("player:update_avatar", { sessionId, pinCode, avatar });
    setBusy(false);
    if (result.status === "ok") onSaved(result.data.avatar);
    else {
      setAvatar(saved);
      setFailed(true);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[440px] flex-col gap-5">
      <div>
        <h2 className="text-title-sm font-semibold">{t("player.avatar.title")}</h2>
        <p className="text-small break-words text-muted-foreground">{nickname}</p>
      </div>
      {!inLobby && (
        <p role="note" className="rounded-md border border-border bg-subtle p-3 text-small">
          {t("validation.errors.invalidPhase")}
        </p>
      )}
      <AvatarPicker
        avatar={avatar}
        nickname={nickname}
        disabled={busy || !inLobby}
        onChange={setAvatar}
        onDice={dice}
        {...(loader ? { loader } : {})}
      />
      {failed && (
        <p
          role="alert"
          className="rounded-md border border-danger bg-danger-surface p-3 text-small text-danger"
        >
          {t("player.inventory.f12.error")}
        </p>
      )}
      <ActionButton
        size="lg"
        pending={busy}
        disabled={!inLobby}
        {...(!inLobby ? { disabledReason: t("validation.errors.invalidPhase") } : {})}
        label={t("player.avatar.saveAvatar")}
        onPress={() => void save()}
      />
    </div>
  );
}
