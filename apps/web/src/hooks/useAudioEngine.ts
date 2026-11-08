"use client";
/**
 * Audio orchestration for host and player screens (Audio revision 2026-10-31; US-07/13/18/19;
 * TASK-130A). Maps authoritative room state to `AudioManager` actions — the server snapshot and
 * clock decide every cue; the client never invents phases, results or winners.
 *
 * Role matrix (host / player):
 * - LOBBY: host plays the quiz lobby track (a specific installed id, else one random pick per
 *   session lobby, never re-rolled on re-render or reconnect); player silent. `cycleNextLobbyTrack`
 *   advances in manifest order with a 500 ms crossfade.
 * - Joins/avatar/submit signals: host nekoPop per join (manager throttles bursts to 1/150 ms);
 *   player nekoPop for its own join, avatar randomize and an accepted answer.
 * - GAME_START_COUNTDOWN: host fades the lobby out (400 ms) then hyoshigiStart once; player silent
 *   (optional 100 ms vibration).
 * - QUESTION_PREVIEW: host fades music out (400 ms) and plays questionWhoosh once; player silent.
 * - QUESTION_ANSWERING: host thinking music — puzzle for ORDER_PUZZLE or ≥ 60 s, sprint for ≤ 15 s,
 *   else standard. For questions of ≥ 10 s, entering the last 5 s sets rate 1.22 once and ticks
 *   once per displayed second 5…1 (deduplicated per session/question/phase/second, never replayed
 *   after a hidden tab or recovery); at the input deadline the music stops and the rate resets.
 *   Player: no music, except Streamer rooms when the player opted in (thinking music only).
 * - ANSWER_REVEAL: host stops thinking music, timeupGong, revealBar after 450 ms. Player:
 *   CORRECT/PARTIAL → answerCorrect (+ vibration [80,50,80]); INCORRECT/UNANSWERED → answerWrong
 *   (+ 250 ms); a positive result with streak ≥ 3 adds streakFire after 350 ms; POLL/NOT_ELIGIBLE
 *   get nothing.
 * - LEADERBOARD: host groove with a 300 ms fade-in; player silent.
 * - PODIUM (from the authoritative phase start): buildup at 0 ms, rank 3/2/1 spotlights at
 *   1200/3500/6500 ms (absent ranks skipped), at the first-place cue buildup stops and victory
 *   (0.95) starts; no winners → no winner effects. A player on the podium hears answerCorrect when
 *   their rank appears. FINISHED keeps the final music without restarting it.
 * - Delayed cues are cancelled by generation on every phase change and on exit; cues whose time
 *   has passed by more than 300 ms (reconnect, hidden tab) are skipped, never replayed late.
 * - The first pointer/key/touch gesture unlocks audio; `unlock()` retries explicitly when blocked.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AUDIO_MANIFEST_URL,
  AUDIO_TIMING,
  DEFAULT_AUDIO_TRACK,
} from "@kabuki-neko/shared/constants/audio";
import { audioManifestSchema, type AudioManifest } from "@kabuki-neko/shared/schemas/audio.schema";
import {
  getAudioManager,
  type AudioManager,
  type AudioStatus,
  type BgmKey,
} from "@/lib/audio-manager";
import type { RoomSnapshot } from "@/stores/game.store";
import { hydrateAudioPreferences, useAudioStore } from "@/stores/useAudioStore";

/** Cues may still play this late (ms) after their scheduled time; older ones are skipped. */
export const CUE_TOLERANCE_MS = 300;
/** How often the hurry-up/tick logic re-reads the clock. */
const TICK_CHECK_MS = 100;

/** Local signals that are not part of the room snapshot. */
export type AudioSignal = "playerJoined" | "ownJoin" | "avatarRandomized" | "answerAccepted";

/** Options of {@link useAudioEngine}. */
export interface AudioEngineOptions {
  role: "host" | "player";
  snapshot: RoomSnapshot | null;
  /** Server-synchronized clock (epoch ms). */
  serverNow: () => number;
  /** Manifest (tests); loaded from `/audio/audio-manifest.json` when omitted. */
  manifest?: AudioManifest | null;
  manager?: AudioManager;
  /** Vibration (tests); defaults to `navigator.vibrate` when the API exists. */
  vibrate?: ((pattern: number | number[]) => void) | null;
  /** Page visibility (tests); defaults to `document.hidden`. */
  isHidden?: () => boolean;
  /** Fetch for the manifest (tests). */
  fetchManifest?: () => Promise<unknown>;
  random?: () => number;
}

/** Thinking track for a question (puzzle priority, then duration). */
export function thinkingVariant(question: {
  type: string;
  timeLimitSec: number;
}): "sprint" | "standard" | "puzzle" {
  if (question.type === "ORDER_PUZZLE" || question.timeLimitSec >= 60) return "puzzle";
  if (question.timeLimitSec <= 15) return "sprint";
  return "standard";
}

/** Default vibration when supported (silently absent otherwise). */
function defaultVibrate(): ((pattern: number | number[]) => void) | null {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function"
    ? (pattern) => {
        try {
          navigator.vibrate(pattern);
        } catch {
          // Unsupported or not allowed: haptics are optional.
        }
      }
    : null;
}

/** Orchestrates all game audio for one role. */
export function useAudioEngine(options: AudioEngineOptions) {
  const manager = options.manager ?? getAudioManager();
  const opts = useRef(options);
  opts.current = options;
  const [status, setStatus] = useState<AudioStatus>(manager.getStatus());
  const [manifest, setManifest] = useState<AudioManifest | null>(options.manifest ?? null);
  const played = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const generation = useRef(0);
  const lobbyPick = useRef(new Map<string, string>());
  const lastSession = useRef<string | null>(null);

  /** Plays a cue once per key. */
  const once = useCallback((key: string, action: () => void) => {
    if (played.current.has(key)) return;
    played.current.add(key);
    action();
  }, []);

  /** Cancels every scheduled cue (phase change, exit). */
  const cancelScheduled = useCallback(() => {
    generation.current += 1;
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear();
  }, []);

  /**
   * Schedules a cue at `offsetMs` after `startAt` (server time). Late cues within the tolerance
   * play immediately; older ones are skipped. Hidden tabs skip sound effects (`skipWhenHidden`);
   * music transitions always apply so the right track is playing when the tab returns.
   */
  const scheduleAt = useCallback(
    (startAt: number, offsetMs: number, key: string, action: () => void, skipWhenHidden = true) => {
      const run = () => {
        if (
          skipWhenHidden &&
          (opts.current.isHidden?.() ?? (typeof document !== "undefined" && document.hidden))
        ) {
          played.current.add(key); // skipped, never replayed later
          return;
        }
        once(key, action);
      };
      const delay = startAt + offsetMs - opts.current.serverNow();
      if (delay < -CUE_TOLERANCE_MS) {
        played.current.add(key);
        return;
      }
      if (delay <= 0) {
        run();
        return;
      }
      const at = generation.current;
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        if (at === generation.current) run();
      }, delay);
      timers.current.add(timer);
    },
    [once],
  );

  // Ownership, preferences, manifest and status.
  useEffect(() => {
    const lease = manager.acquire();
    void hydrateAudioPreferences();
    const apply = () => {
      const prefs = useAudioStore.getState();
      manager.setPreferences({
        isMuted: prefs.isMuted,
        masterVolume: prefs.masterVolume,
        bgmVolume: prefs.bgmVolume,
        sfxVolume: prefs.sfxVolume,
      });
    };
    apply();
    const offPrefs = useAudioStore.subscribe(apply);
    const offStatus = manager.onStatus(setStatus);
    return () => {
      offPrefs();
      offStatus();
      cancelScheduled();
      manager.release(lease);
    };
  }, [manager, cancelScheduled]);

  useEffect(() => {
    if (options.manifest !== undefined) {
      setManifest(options.manifest);
      return;
    }
    let cancelled = false;
    const load =
      opts.current.fetchManifest ??
      (() =>
        fetch(AUDIO_MANIFEST_URL, { cache: "force-cache" }).then((response) => response.json()));
    load()
      .then((json) => {
        const parsed = audioManifestSchema.safeParse(json);
        if (!cancelled) setManifest(parsed.success ? parsed.data : null);
      })
      .catch(() => {
        if (!cancelled) setManifest(null);
      });
    return () => {
      cancelled = true;
    };
  }, [options.manifest]);

  useEffect(() => {
    manager.setManifest(manifest);
  }, [manager, manifest]);

  // First user gesture unlocks audio; keep listening while still blocked.
  useEffect(() => {
    const unlock = () => {
      void manager.unlock().then((ok) => {
        if (ok) remove();
      });
    };
    const events = ["pointerdown", "keydown", "touchstart"] as const;
    const remove = () => events.forEach((event) => window.removeEventListener(event, unlock));
    events.forEach((event) => window.addEventListener(event, unlock, { passive: true }));
    return remove;
  }, [manager]);

  const snapshot = options.snapshot;
  const role = options.role;
  const sessionId = snapshot?.sessionId ?? null;
  const phase = snapshot?.phase ?? null;
  const phaseVersion = snapshot?.phaseVersion ?? 0;
  const questionId = snapshot?.question?.id ?? null;

  // A different session starts with clean dedup state; leaving a room stops everything.
  useEffect(() => {
    if (sessionId !== lastSession.current) {
      played.current.clear();
      lastSession.current = sessionId;
    }
    if (sessionId === null) {
      cancelScheduled();
      manager.stopAll();
    }
  }, [sessionId, manager, cancelScheduled]);

  /** The lobby track for this session (specific id, else one random pick per session). */
  const lobbyTrackFor = useCallback(
    (session: string, requested: string | undefined): string | null => {
      const tracks = manifest?.lobby ?? [];
      if (tracks.length === 0) return null;
      // The session's choice (initial pick or "Next BGM") wins once made.
      let pick = lobbyPick.current.get(session);
      if (!pick || !tracks.some((track) => track.id === pick)) {
        if (
          requested &&
          requested !== DEFAULT_AUDIO_TRACK &&
          tracks.some((track) => track.id === requested)
        )
          pick = requested;
        else {
          const random = opts.current.random ?? Math.random;
          pick = tracks[Math.floor(random() * tracks.length)]?.id ?? tracks[0]?.id;
        }
        if (pick) lobbyPick.current.set(session, pick);
      }
      return pick ?? null;
    },
    [manifest],
  );

  // Only changes that matter for audio re-run the choreography (not joins or presence).
  const streamerOptIn = useAudioStore((state) => state.streamerBgmOptIn);
  const resultKey =
    snapshot?.role === "player" && snapshot.self.result
      ? `${snapshot.self.result.result}:${snapshot.self.result.currentStreak}`
      : "";
  const podiumKey = snapshot
    ? snapshot.podium.map((entry) => `${entry.playerId}:${entry.rank}`).join(",")
    : "";
  const bgmTrack = snapshot?.role === "host" ? snapshot.bgmTrack : undefined;
  const displayMode = snapshot?.displayMode ?? null;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  // Phase choreography.
  useEffect(() => {
    const snapshot = snapshotRef.current;
    if (!snapshot || !manifest || !phase || !sessionId) return;
    cancelScheduled();
    const key = (cue: string) => `${sessionId}:${phaseVersion}:${cue}`;
    const timing = snapshot.timing;
    const start = timing.phaseStartedAt;
    const vibrate = opts.current.vibrate === undefined ? defaultVibrate() : opts.current.vibrate;
    const bgm = (target: BgmKey, extra?: Parameters<AudioManager["playBgm"]>[1]) =>
      void manager.playBgm(target, extra);

    if (role === "host") {
      if (phase === "LOBBY") {
        const id = lobbyTrackFor(
          sessionId,
          snapshot.role === "host" ? snapshot.bgmTrack : undefined,
        );
        if (id) {
          useAudioStore.getState().setCurrentLobbyTrackId(id);
          bgm({ kind: "lobby", id });
        }
      } else if (phase === "GAME_START_COUNTDOWN") {
        manager.stopBgm(AUDIO_TIMING.lobbyFadeOutMs);
        scheduleAt(
          start,
          AUDIO_TIMING.lobbyFadeOutMs,
          key("hyoshigi"),
          () => void manager.playSfx("hyoshigiStart"),
        );
      } else if (phase === "QUESTION_PREVIEW") {
        manager.stopBgm(AUDIO_TIMING.leaderboardFadeOutMs);
        scheduleAt(start, 0, key("whoosh"), () => void manager.playSfx("questionWhoosh"));
      } else if (phase === "QUESTION_ANSWERING" && snapshot.question) {
        const closes = timing.inputClosesAt ?? start;
        if (opts.current.serverNow() < closes)
          bgm({ kind: "thinking", variant: thinkingVariant(snapshot.question) });
      } else if (phase === "ANSWER_REVEAL") {
        manager.setBgmRate(AUDIO_TIMING.normalRate);
        manager.stopBgm();
        scheduleAt(start, 0, key("gong"), () => void manager.playSfx("timeupGong"));
        scheduleAt(
          start,
          AUDIO_TIMING.revealBarDelayMs,
          key("revealBar"),
          () => void manager.playSfx("revealBar"),
        );
      } else if (phase === "LEADERBOARD") {
        bgm({ kind: "leaderboard" }, { fadeInMs: AUDIO_TIMING.leaderboardFadeInMs });
      } else if (phase === "PODIUM" || phase === "FINISHED") {
        const ranks = new Set(snapshot.podium.map((entry) => entry.rank));
        const hasWinners = snapshot.podium.length > 0;
        const elapsed = opts.current.serverNow() - start;
        const victoryAt = AUDIO_TIMING.podiumFirstMs;
        if (phase === "FINISHED") {
          // Keep the final music; only settle it after a recovery straight into FINISHED.
          if (hasWinners && manager.currentBgm === null)
            bgm(
              { kind: "podium", variant: "victory" },
              { volume: AUDIO_TIMING.podiumVictoryVolume },
            );
        } else if (hasWinners && elapsed >= victoryAt) {
          // Past the first-place cue (re-render or reconnect): settle on victory, never go back.
          bgm({ kind: "podium", variant: "victory" }, { volume: AUDIO_TIMING.podiumVictoryVolume });
          if (ranks.has(1) && elapsed < victoryAt + CUE_TOLERANCE_MS)
            scheduleAt(
              start,
              victoryAt,
              key("spotlight-1"),
              () => void manager.playSfx("podiumSpotlight"),
            );
        } else if (hasWinners) {
          bgm({ kind: "podium", variant: "buildup" });
          const cues: [number, number][] = [
            [3, AUDIO_TIMING.podiumThirdMs],
            [2, AUDIO_TIMING.podiumSecondMs],
            [1, AUDIO_TIMING.podiumFirstMs],
          ];
          for (const [rank, offset] of cues)
            if (ranks.has(rank))
              scheduleAt(
                start,
                offset,
                key(`spotlight-${rank}`),
                () => void manager.playSfx("podiumSpotlight"),
              );
          // Buildup stops and victory starts at the first-place time (even without a 1st place
          // entry), also in a hidden tab so the right music plays when it returns.
          scheduleAt(
            start,
            victoryAt,
            key("victory"),
            () =>
              bgm(
                { kind: "podium", variant: "victory" },
                { volume: AUDIO_TIMING.podiumVictoryVolume },
              ),
            false,
          );
        } else manager.stopBgm();
      }
      return;
    }

    // Player.
    if (snapshot.role !== "player") return;
    const optedIn = snapshot.displayMode === "STREAMER" && streamerOptIn;
    if (phase === "QUESTION_ANSWERING" && snapshot.question && optedIn) {
      const closes = timing.inputClosesAt ?? start;
      if (opts.current.serverNow() < closes) {
        bgm({ kind: "thinking", variant: thinkingVariant(snapshot.question) });
        scheduleAt(closes, 0, key("player-stop"), () => manager.stopBgm(), false);
      }
    } else if (phase === "GAME_START_COUNTDOWN") {
      manager.stopBgm();
      scheduleAt(start, 0, key("countdown-vibrate"), () => vibrate?.(100));
    } else manager.stopBgm();

    if (phase === "ANSWER_REVEAL") {
      const result = snapshot.self.result;
      if (result) {
        const positive = result.result === "CORRECT" || result.result === "PARTIAL";
        const negative = result.result === "INCORRECT" || result.result === "UNANSWERED";
        if (positive)
          scheduleAt(start, 0, key("correct"), () => {
            void manager.playSfx("answerCorrect");
            vibrate?.([80, 50, 80]);
          });
        if (negative)
          scheduleAt(start, 0, key("wrong"), () => {
            void manager.playSfx("answerWrong");
            vibrate?.(250);
          });
        if (positive && result.currentStreak >= 3)
          scheduleAt(
            start,
            AUDIO_TIMING.streakFireDelayMs,
            key("streak"),
            () => void manager.playSfx("streakFire"),
          );
      }
    } else if (phase === "PODIUM") {
      const mine = snapshot.podium.find((entry) => entry.playerId === snapshot.self.playerId);
      const offsets: Record<number, number> = {
        3: AUDIO_TIMING.podiumThirdMs,
        2: AUDIO_TIMING.podiumSecondMs,
        1: AUDIO_TIMING.podiumFirstMs,
      };
      const offset = mine ? offsets[mine.rank] : undefined;
      if (offset !== undefined)
        scheduleAt(start, offset, key("my-rank"), () => void manager.playSfx("answerCorrect"));
    }
  }, [
    manifest,
    phase,
    phaseVersion,
    sessionId,
    questionId,
    role,
    resultKey,
    podiumKey,
    bgmTrack,
    displayMode,
    streamerOptIn,
    manager,
    cancelScheduled,
    scheduleAt,
    lobbyTrackFor,
  ]);

  // Host hurry-up and ticks in the last five seconds (clock-driven, never replayed).
  useEffect(() => {
    if (role !== "host" || phase !== "QUESTION_ANSWERING" || !snapshot?.question || !sessionId)
      return;
    const closes = snapshot.timing.inputClosesAt;
    if (closes === null) return;
    const longEnough = snapshot.question.timeLimitSec >= AUDIO_TIMING.hurryUpMinDurationSec;
    const prefix = `${sessionId}:${questionId}:${phaseVersion}`;
    let lastSecond: number | null = null;
    const check = () => {
      const remaining = closes - opts.current.serverNow();
      if (remaining <= 0) {
        manager.setBgmRate(AUDIO_TIMING.normalRate);
        manager.stopBgm();
        clearInterval(timer);
        return;
      }
      if (!longEnough) return;
      const second = Math.ceil(remaining / 1000);
      if (second > AUDIO_TIMING.hurryUpSeconds) return;
      once(`${prefix}:hurry`, () => manager.setBgmRate(AUDIO_TIMING.hurryUpRate));
      const hidden =
        opts.current.isHidden?.() ?? (typeof document !== "undefined" && document.hidden);
      if (second !== lastSecond) {
        lastSecond = second;
        const tickKey = `${prefix}:tick-${second}`;
        if (hidden) played.current.add(tickKey);
        else once(tickKey, () => void manager.playSfx("tickLast5s"));
      }
    };
    const timer = setInterval(check, TICK_CHECK_MS);
    // First check after the phase effect started the thinking music.
    const first = setTimeout(check, 0);
    return () => {
      clearInterval(timer);
      clearTimeout(first);
    };
  }, [
    role,
    phase,
    phaseVersion,
    sessionId,
    questionId,
    snapshot?.question,
    snapshot?.timing.inputClosesAt,
    manager,
    once,
  ]);

  /** Local signals (joins, avatar, accepted answers). */
  const signal = useCallback(
    (event: AudioSignal, id?: string) => {
      const current = opts.current;
      if (event === "playerJoined" && current.role === "host")
        void manager.playSfx("nekoPop", id ? { eventId: `join:${id}` } : {});
      if (
        current.role === "player" &&
        (event === "ownJoin" || event === "avatarRandomized" || event === "answerAccepted")
      )
        void manager.playSfx("nekoPop", id ? { eventId: `${event}:${id}` } : {});
    },
    [manager],
  );

  /** Advances the lobby track in manifest order with a 500 ms crossfade (host, LOBBY only). */
  const cycleNextLobbyTrack = useCallback(() => {
    const current = opts.current.snapshot;
    const tracks = manifest?.lobby ?? [];
    if (!current || current.phase !== "LOBBY" || tracks.length === 0) return;
    const active =
      lobbyPick.current.get(current.sessionId) ?? useAudioStore.getState().currentLobbyTrackId;
    const index = tracks.findIndex((track) => track.id === active);
    const next = tracks[(index + 1) % tracks.length];
    if (!next) return;
    lobbyPick.current.set(current.sessionId, next.id);
    useAudioStore.getState().setCurrentLobbyTrackId(next.id);
    void manager.playBgm(
      { kind: "lobby", id: next.id },
      { crossfadeMs: AUDIO_TIMING.lobbyCrossfadeMs },
    );
  }, [manager, manifest]);

  const unlock = useCallback(() => manager.unlock(), [manager]);

  return { status, signal, cycleNextLobbyTrack, unlock, manifestReady: manifest !== null };
}
