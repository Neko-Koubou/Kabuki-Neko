/**
 * Role projections of the private room state (SA §5.3, ADR-04).
 *
 * Every field of a host or player snapshot is copied explicitly by an allowlist constructor —
 * never by spreading or deleting keys from the private object — and the result is validated by
 * the shared phase-discriminated schema before it leaves the state layer. Before reveal no answer
 * key, explanation, accepted text, puzzle order or private option mapping is reachable: PREVIEW has
 * `options=[]`/`media=null`, ANSWERING exposes only public options (TYPE_ANSWER keeps `[]`). A
 * player sees only their own accepted answer and personal result, scores stay at the last
 * finalized question until reveal, and finalization/reportId are host-only. PROJECTOR and STREAMER
 * receive the same permitted content; only the client layout differs.
 */
import {
  finalizeStatusSchema,
  hostRoomSyncSchema,
  playerRoomSyncSchema,
  type FinalizeStatus,
  type HostRoomSync,
  type PlayerRoomSync,
  type PublicQuestion,
  type Reveal,
} from "@kabuki-neko/shared/schemas/game.schema";
import { playerPodiumDataSchema, playerRevealDataSchema } from "@kabuki-neko/shared/socket-events";
import type { z } from "zod";
import {
  StateDomainError,
  type ActiveRoomState,
  type Principal,
  type RoomProjector,
} from "../../providers/state/game-state.interface";
import { buildPodium, type Leaderboard, type RankablePlayer } from "./ranking";

type Phase = ActiveRoomState["phase"];
type PrivateQuestion = ActiveRoomState["quiz"]["questions"][number];

/** Phases in which the current question's options and media are public. */
const OPEN_PHASES: ReadonlySet<Phase> = new Set([
  "QUESTION_ANSWERING",
  "ANSWER_REVEAL",
  "LEADERBOARD",
]);
/** Phases before the final podium, in which the host may still end the game. */
const ACTIVE_PHASES: ReadonlySet<Phase> = new Set([
  "LOBBY",
  "GAME_START_COUNTDOWN",
  "QUESTION_PREVIEW",
  "QUESTION_ANSWERING",
  "ANSWER_REVEAL",
  "LEADERBOARD",
]);

/** Public question view; options/media only once answering has opened. */
function publicQuestion(
  question: PrivateQuestion,
  questionIndex: number,
  totalQuestions: number,
  open: boolean,
): PublicQuestion {
  return {
    id: question.id,
    questionIndex,
    totalQuestions,
    type: question.type,
    promptText: question.promptText,
    pointsMultiplier: question.pointsMultiplier,
    timeLimitSec: question.timeLimitSec,
    media: open ? question.mediaSnapshot : null,
    options:
      open && question.type !== "TYPE_ANSWER"
        ? question.publicOptions.map((option) => ({
            id: option.id,
            index: option.index,
            colorIndex: option.colorIndex,
            text: option.text,
          }))
        : [],
  };
}
/** Most recent committed leaderboard at or before the current question. */
function latestLeaderboard(state: Readonly<ActiveRoomState>): Leaderboard | null {
  const indices = Object.keys(state.results)
    .map(Number)
    .sort((a, b) => b - a);
  const latest = indices[0];
  return latest === undefined ? null : (state.results[String(latest)]?.leaderboard ?? null);
}
/** Ranking view of the stored players (totals are only written at question commit). */
function rankable(state: Readonly<ActiveRoomState>): RankablePlayer[] {
  return Object.values(state.players).map((player) => ({
    id: player.id,
    nickname: player.nickname,
    avatar: player.avatar,
    joinOrder: player.joinOrder,
    kicked: player.kickedAt !== null,
    score: player.score,
    correctCount: player.correctCount,
    responseSumMs: player.responseSumMs,
    responseCount: player.responseCount,
    previousRank: player.previousRank,
  }));
}

/** Fields shared by host and player snapshots, built from an explicit allowlist. */
function roomBase(state: Readonly<ActiveRoomState>, now: number) {
  const phase = state.phase;
  const totalQuestions = state.quiz.questions.length;
  const index = state.questionIndex;
  const privateQuestion = index === null ? undefined : state.quiz.questions[index];
  const final = phase === "PODIUM" || phase === "FINISHED";
  const result = index === null ? undefined : state.results[String(index)];
  let question: PublicQuestion | null = null;
  if (
    privateQuestion &&
    index !== null &&
    !final &&
    phase !== "LOBBY" &&
    phase !== "GAME_START_COUNTDOWN"
  )
    question = publicQuestion(privateQuestion, index, totalQuestions, OPEN_PHASES.has(phase));
  const revealVisible = phase === "ANSWER_REVEAL" || phase === "LEADERBOARD";
  return {
    sessionId: state.sessionId,
    pinCode: state.pinCode,
    revision: state.revision,
    publicRevision: state.publicRevision,
    phaseVersion: state.phaseVersion,
    serverTime: now,
    phase,
    quizTitle: state.quiz.title,
    totalQuestions,
    displayMode: state.displayMode,
    friendlyNicknames: state.friendlyNicknames,
    isLocked: state.isLocked,
    maxPlayers: state.maxPlayers,
    players: Object.values(state.players)
      .filter((player) => player.kickedAt === null)
      .sort((a, b) => a.joinOrder - b.joinOrder)
      .map((player) => ({
        id: player.id,
        nickname: player.nickname,
        avatar: { style: player.avatar.style, seed: player.avatar.seed },
        connected: player.connected,
        joinOrder: player.joinOrder,
      })),
    question,
    timing: {
      phaseStartedAt: state.timing.phaseStartedAt,
      phaseEndsAt: state.timing.phaseEndsAt,
      questionStartedAt: state.timing.questionStartedAt,
      inputClosesAt: state.timing.inputClosesAt,
      acceptanceClosesAt: state.timing.acceptanceClosesAt,
    },
    reveal: revealVisible && result ? result.reveal : null,
    leaderboard:
      phase === "LOBBY" || phase === "GAME_START_COUNTDOWN" ? null : latestLeaderboard(state),
    podium: final ? buildPodium(rankable(state)) : [],
    endReason: final ? (state.endReason ?? "COMPLETED") : null,
  };
}

/** Host snapshot: base plus answer progress, finalization and phase capabilities. */
export function projectHost(
  state: Readonly<ActiveRoomState>,
  hostId: string,
  now: number,
): HostRoomSync {
  if (hostId !== state.hostId) throw new StateDomainError("FORBIDDEN");
  const phase = state.phase;
  const index = state.questionIndex;
  const required = state.requiredPlayerIds.filter(
    (id) => state.players[id] && state.players[id].kickedAt === null,
  );
  const answered =
    index === null
      ? 0
      : required.filter((id) => state.answers[`${index}:${id}`] !== undefined).length;
  const connected = Object.values(state.players).filter(
    (player) => player.kickedAt === null && player.connected,
  ).length;
  return hostRoomSyncSchema.parse({
    ...roomBase(state, now),
    role: "host",
    bgmTrack: state.quiz.bgmTrack,
    answeredCount: phase === "QUESTION_ANSWERING" || phase === "ANSWER_REVEAL" ? answered : 0,
    eligibleCount:
      phase === "QUESTION_ANSWERING" || phase === "ANSWER_REVEAL" ? required.length : 0,
    finalization: finalizationOf(state),
    capabilities: {
      canStart: phase === "LOBBY" && connected > 0,
      canLock: phase === "LOBBY",
      canKick: ACTIVE_PHASES.has(phase),
      canSkip: phase === "QUESTION_ANSWERING" && state.accepting,
      canNext: phase === "ANSWER_REVEAL" || phase === "LEADERBOARD",
      canEnd: ACTIVE_PHASES.has(phase),
    },
  });
}

/** Player snapshot: base plus only the requesting player's own score, answer and result. */
export function projectPlayer(
  state: Readonly<ActiveRoomState>,
  playerId: string,
  generation: number,
  now: number,
): PlayerRoomSync {
  const player = state.players[playerId];
  if (!player) throw new StateDomainError("INVALID_SESSION_TOKEN");
  if (player.kickedAt !== null) throw new StateDomainError("PLAYER_KICKED");
  if (player.connectionGeneration !== generation) throw new StateDomainError("SESSION_REPLACED");
  const phase = state.phase;
  const index = state.questionIndex;
  const stored = index === null ? undefined : state.answers[`${index}:${playerId}`];
  const showAnswer = stored !== undefined && OPEN_PHASES.has(phase);
  const latest = Object.keys(state.results)
    .map(Number)
    .sort((a, b) => b - a)[0];
  const resultIndex =
    phase === "ANSWER_REVEAL" || phase === "LEADERBOARD"
      ? index
      : phase === "PODIUM" || phase === "FINISHED"
        ? (latest ?? null)
        : null;
  const personal =
    resultIndex === null ? undefined : state.results[String(resultIndex)]?.personal[playerId];
  return playerRoomSyncSchema.parse({
    ...roomBase(state, now),
    role: "player",
    self: {
      playerId: player.id,
      score: player.score,
      streak: player.streak,
      rank: player.rank,
      acceptedAnswer: showAnswer
        ? {
            submissionId: stored.submissionId,
            questionIndex: stored.questionIndex,
            receivedAt: stored.receivedAt,
            answer: stored.answer,
          }
        : null,
      result: personal ?? null,
    },
  });
}

/** Host-only finalization fields, copied by allowlist (validated by the caller's schema). */
function finalizationOf(state: Readonly<ActiveRoomState>) {
  const status = state.finalization;
  return status
    ? {
        sessionId: status.sessionId,
        status: status.status,
        reportId: status.reportId,
        retryable: status.retryable,
        errorCode: status.errorCode,
        updatedAt: status.updatedAt,
      }
    : null;
}

/**
 * `report:status_changed` data for the host: the same allowlisted finalization fields as the host
 * snapshot, without projecting the whole room (QA follow-up TASK-185C).
 */
export function projectFinalization(state: Readonly<ActiveRoomState>): FinalizeStatus | null {
  const status = finalizationOf(state);
  return status ? finalizeStatusSchema.parse(status) : null;
}

/** The current personal result of one player, for the reveal or the podium push. */
function personalResult(state: Readonly<ActiveRoomState>, playerId: string, index: number | null) {
  return index === null ? undefined : state.results[String(index)]?.personal[playerId];
}

/**
 * `game:answer_reveal` data for one player: the room's public reveal (shared, computed once per
 * publish) plus only that player's own personal result. It equals the `reveal` and `self.result`
 * of `projectPlayer` for the player, without validating a whole room snapshot per player, which
 * made a 200-player reveal O(n²) (QA follow-up TASK-185C). Null when the player has no result.
 */
export function projectPlayerReveal(
  state: Readonly<ActiveRoomState>,
  playerId: string,
  reveal: Reveal,
): z.infer<typeof playerRevealDataSchema> | null {
  const result = personalResult(state, playerId, state.questionIndex);
  return result ? playerRevealDataSchema.parse({ reveal, result }) : null;
}

/**
 * `game:podium` data for one player: the room's podium (shared) plus only that player's result
 * of the last scored question, as `projectPlayer` reports it at PODIUM (TASK-185C).
 */
export function projectPlayerPodium(
  state: Readonly<ActiveRoomState>,
  playerId: string,
  podium: HostRoomSync["podium"],
): z.infer<typeof playerPodiumDataSchema> {
  const latest = Object.keys(state.results)
    .map(Number)
    .sort((a, b) => b - a)[0];
  return playerPodiumDataSchema.parse({
    podium,
    result: personalResult(state, playerId, latest ?? null) ?? null,
  });
}

/** The projector installed into both state stores. */
export const projectRoom: RoomProjector = (state, principal: Principal, now) =>
  principal.role === "host"
    ? projectHost(state, principal.hostId, now)
    : projectPlayer(state, principal.playerId, principal.generation, now);
