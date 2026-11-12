/**
 * Room scheduler: timer leases, deadlines, lifetime and retention (SA §6.2).
 *
 * Every instance scans its database's ACTIVE/FINALIZING allocations once per second. Per room, one
 * instance holds a 3000 ms state-store lease (owner + epoch, renewed every scan ≈ 1000 ms); only the
 * holder ticks the room and arms a local timer for the exact next deadline. The scan itself repairs
 * missed timers — correctness never depends on the lease, because every transition is a phase CAS
 * in GameService. Host presence is never consulted, so a disconnected host does not pause timers.
 *
 * Lifetime: hard expiry 8 h from creation (an ANSWERING question is closed with EXPIRED and the
 * game goes to PODIUM; any other phase cannot be frozen and is marked LOST — no invented report),
 * lobby idle 2 h (LOST), SQL heartbeat every 30 s, FINISHED retention 1 h after which a room whose
 * report is durable (finalization ready) is released and its allocation CLOSED. A frozen report that
 * is not yet durable is never evicted (the store refuses to release it). Missing state means LOST.
 * CLOSED/LOST allocations are released conditionally after 1 h, retried every scan.
 *
 * Finalization recovery: the leader of a final room whose frozen report is not `ready` asks the
 * game service to re-sync it with the durable queue at most every 5 s (re-enqueue after a database
 * outage, mirror a READY job whose state update was lost), so such rooms are eventually released.
 * A frozen report still not durable 24 h after the game ended raises one error-level alarm per
 * session (`finalization pending for more than 24 h`, session id only) and is still never evicted.
 */
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { RuntimeRepository, type Allocation } from "@kabuki-neko/database";
import { ROOM_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { ConfigService } from "../../config/config.service";
import {
  GAME_STATE_STORE,
  StateDomainError,
  type ActiveRoomState,
  type IGameStateStore,
  type Lease,
  type RoomIdentity,
} from "../../providers/state/game-state.interface";
import { GAME_CLOCK, GameService, type RoomEndReason } from "./game.service";
import { RoomRegistryService } from "./room-registry.service";

/** Minimum interval between finalization re-syncs of one room by its leader. */
export const FINALIZATION_SYNC_MS = 5_000;
/** Phases after which no gameplay transition remains except PODIUM → FINISHED. */
const FINAL = new Set<ActiveRoomState["phase"]>(["PODIUM", "FINISHED"]);

/** Next instant at which `tick` has work to do, or null for untimed phases. */
export function nextDeadline(state: Readonly<ActiveRoomState>): number | null {
  if (state.phase === "QUESTION_ANSWERING")
    return state.accepting && state.timing.acceptanceClosesAt !== null
      ? state.timing.acceptanceClosesAt + 1
      : null;
  if (
    state.phase === "GAME_START_COUNTDOWN" ||
    state.phase === "QUESTION_PREVIEW" ||
    state.phase === "PODIUM"
  )
    return state.timing.phaseEndsAt;
  return null;
}

@Injectable()
export class RoomScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly owner: string;
  private readonly clock: () => number;
  private readonly leases = new Map<string, Lease>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly heartbeats = new Map<string, number>();
  private readonly pins = new Map<string, string>();
  private readonly synced = new Map<string, number>();
  /** Sessions whose 24 h pending alarm was already raised (once per session and process). */
  private readonly alarmed = new Set<string>();
  private readonly logger = new Logger(RoomScheduler.name);
  private interval: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;

  constructor(
    @Inject(RuntimeRepository) private readonly runtime: RuntimeRepository,
    @Inject(RoomRegistryService) private readonly registry: RoomRegistryService,
    @Inject(GAME_STATE_STORE) private readonly store: IGameStateStore,
    @Inject(GameService) private readonly game: GameService,
    @Inject(ConfigService) config: ConfigService,
    @Optional() @Inject(GAME_CLOCK) clock: (() => number) | null = null,
  ) {
    this.owner = config.values.DEPLOYMENT_INSTANCE_ID;
    this.clock = clock ?? Date.now;
  }

  /** Startup reconciliation (rooms without state become LOST), then the 1 s scan loop. */
  async onApplicationBootstrap(): Promise<void> {
    await this.scan().catch(() => undefined);
    this.interval = setInterval(() => void this.scanOnce(), ROOM_LIMITS.scanIntervalMs);
    this.interval.unref();
  }
  /** Stops timers and gives up held leases so another instance can take over quickly. */
  async onModuleDestroy(): Promise<void> {
    clearInterval(this.interval);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.running;
    for (const [sessionId, lease] of this.leases) {
      const pin = this.pins.get(sessionId);
      if (pin) await this.store.releaseLease({ pin, sessionId }, lease).catch(() => false);
    }
    this.leases.clear();
  }
  /** Non-overlapping scan used by the interval. */
  private scanOnce(): Promise<void> {
    this.running ??= this.scan()
      .catch(() => undefined)
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  /** One full pass: CREATING repair, every active room, then retired release retries. */
  async scan(now: number = this.clock()): Promise<void> {
    await this.registry.reconcileCreating(now);
    let after: string | null = null;
    for (;;) {
      const page: Allocation[] = await this.runtime.active(after);
      for (const row of page) await this.visit(row, now).catch(() => undefined);
      if (page.length < 500) break;
      after = page[page.length - 1]?.id ?? null;
    }
    for (const row of await this.runtime.retired(now - ROOM_LIMITS.lostRetentionMs)) {
      await this.store.releaseRoom({ pin: row.pin_code, sessionId: row.id }).catch(() => false);
      await this.runtime.release(row.id, row.pin_code, now);
    }
  }

  /** Acquires or renews this instance's lease; true when it leads the room. */
  private async lead(identity: RoomIdentity, now: number): Promise<boolean> {
    const held = this.leases.get(identity.sessionId);
    if (held && held.expiresAt > now) {
      if (await this.store.renewLease(identity, held, ROOM_LIMITS.schedulerLeaseMs)) {
        this.leases.set(identity.sessionId, {
          ...held,
          expiresAt: now + ROOM_LIMITS.schedulerLeaseMs,
        });
        return true;
      }
      this.leases.delete(identity.sessionId);
    }
    const lease = await this.store.acquireLease(identity, this.owner, ROOM_LIMITS.schedulerLeaseMs);
    if (!lease) return false;
    this.leases.set(identity.sessionId, lease);
    this.pins.set(identity.sessionId, identity.pin);
    return true;
  }
  /** Forgets local scheduling state for a room. */
  private forget(sessionId: string) {
    clearTimeout(this.timers.get(sessionId));
    this.timers.delete(sessionId);
    this.leases.delete(sessionId);
    this.heartbeats.delete(sessionId);
    this.pins.delete(sessionId);
    this.synced.delete(sessionId);
    this.alarmed.delete(sessionId);
  }
  /** Arms a local timer for the exact next deadline (the 1 s scan repairs misses). */
  private arm(identity: RoomIdentity, state: Readonly<ActiveRoomState>) {
    clearTimeout(this.timers.get(identity.sessionId));
    const deadline = nextDeadline(state);
    if (deadline === null) {
      this.timers.delete(identity.sessionId);
      return;
    }
    const timer = setTimeout(
      () => void this.game.tick(identity).catch(() => undefined),
      Math.max(0, deadline - this.clock()),
    );
    timer.unref();
    this.timers.set(identity.sessionId, timer);
  }

  /**
   * Marks an allocation LOST (state missing, idle or expired before any report could exist), drops
   * local scheduling and tells connected clients why (`room:expired`, code review MJ-05).
   */
  private async lose(row: Allocation, now: number, reason: RoomEndReason) {
    if (row.status === "ACTIVE" || row.status === "FINALIZING")
      await this.runtime.transition(row.id, row.status, "LOST", now);
    this.forget(row.id);
    await this.game.roomEnded({ pin: row.pin_code, sessionId: row.id }, reason);
  }

  /** Lifetime, timer and retention handling for one active allocation (leader only). */
  async visit(row: Allocation, now: number = this.clock()): Promise<void> {
    const identity = { pin: row.pin_code, sessionId: row.id };
    const state = await this.store.getPrivateSnapshot(identity);
    if (!state) return this.lose(row, now, "ROOM_LOST");
    if (!(await this.lead(identity, now))) return;
    if (now - (this.heartbeats.get(row.id) ?? 0) >= ROOM_LIMITS.allocationHeartbeatMs) {
      await this.runtime.heartbeat(row.id, now);
      this.heartbeats.set(row.id, now);
    }
    const hard = now >= state.hardExpiresAt;
    const idle = state.phase === "LOBBY" && now >= state.lobbyActiveAt + ROOM_LIMITS.lobbyIdleMs;
    if ((hard || idle) && !FINAL.has(state.phase)) {
      if (state.phase === "QUESTION_ANSWERING") {
        try {
          await this.store.closeQuestion({
            ...identity,
            expectedPhaseVersion: state.phaseVersion,
            reason: "EXPIRED",
          });
        } catch (error) {
          if (!(error instanceof StateDomainError)) throw error;
        }
        await this.game.settle(identity);
      } else {
        await this.store.releaseRoom(identity);
        await this.lose(row, now, "ROOM_EXPIRED");
      }
      return;
    }
    await this.game.tick(identity, now).catch((error: unknown) => {
      // A hard-expired PODIUM can no longer transition; retention handling below still applies.
      if (!(error instanceof StateDomainError && error.code === "ROOM_EXPIRED")) throw error;
    });
    const after = await this.store.getPrivateSnapshot(identity);
    if (!after) return this.lose(row, now, "ROOM_LOST");
    if (FINAL.has(after.phase) && after.frozenReport && row.status === "ACTIVE")
      await this.runtime.transition(row.id, "ACTIVE", "FINALIZING", now);
    if (
      FINAL.has(after.phase) &&
      after.frozenReport &&
      after.finalization?.status !== "ready" &&
      now - (this.synced.get(row.id) ?? -Infinity) >= FINALIZATION_SYNC_MS
    ) {
      this.synced.set(row.id, now);
      await this.game.syncFinalization(identity).catch(() => false);
    }
    // A report that is still not durable a day after the game ended needs an operator.
    if (
      FINAL.has(after.phase) &&
      after.frozenReport &&
      after.finalization?.status !== "ready" &&
      now - after.frozenReport.session.endedAt >= ROOM_LIMITS.pendingAlarmMs &&
      !this.alarmed.has(row.id)
    ) {
      this.alarmed.add(row.id);
      this.logger.error(`finalization pending for more than 24 h for session ${row.id}`);
    }
    // FINISHED rooms are kept 1 h for recovery; a hard-expired room cannot transition any more and
    // is released as soon as its report is durable. Non-durable reports are never released.
    const retained =
      (after.phase === "FINISHED" &&
        now >= after.timing.phaseStartedAt + ROOM_LIMITS.finishedRetentionMs) ||
      (FINAL.has(after.phase) && hard);
    if (
      retained &&
      after.finalization?.status === "ready" &&
      (await this.store.releaseRoom(identity))
    ) {
      await this.runtime.transition(row.id, "FINALIZING", "CLOSED", now);
      this.forget(row.id);
      // Released after retention with a durable report: the gateway forgets it without a push.
      await this.game.roomEnded(identity, null);
      return;
    }
    this.arm(identity, after);
  }
}
