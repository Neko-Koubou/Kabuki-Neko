/**
 * Game engine module: room allocation, join/recovery, the state machine, the room scheduler and
 * the Socket.io gateway. `GameService` is provided as `NotifyingGameService`, which tells the
 * gateway to publish after every scheduler-driven tick so timed transitions reach clients
 * immediately, without the scheduler depending on the transport.
 */
import { Injectable, Module } from "@nestjs/common";
import { CommonModule } from "../../common/common.module";
import type { RoomIdentity } from "../../providers/state/game-state.interface";
import { StateModule } from "../../providers/state/state.module";
import { GameGateway } from "./game.gateway";
import { GameService } from "./game.service";
import { RecoveryService } from "./recovery.service";
import { RoomRegistryService } from "./room-registry.service";
import { RoomScheduler } from "./room-scheduler";

/** GameService that notifies a publisher (the gateway) after each timed tick. */
@Injectable()
export class NotifyingGameService extends GameService {
  private notifier: ((identity: RoomIdentity) => Promise<void>) | null = null;

  /** Installs the publish callback (set by the gateway during initialization). */
  setNotifier(notifier: ((identity: RoomIdentity) => Promise<void>) | null): void {
    this.notifier = notifier;
  }

  /** Runs the timed step, then publishes the resulting room changes. */
  override async tick(identity: RoomIdentity, now?: number): Promise<void> {
    try {
      await super.tick(identity, now);
    } finally {
      await this.notifier?.(identity).catch(() => undefined);
    }
  }
}

@Module({
  imports: [CommonModule, StateModule],
  providers: [
    RoomRegistryService,
    RecoveryService,
    { provide: GameService, useClass: NotifyingGameService },
    RoomScheduler,
    GameGateway,
  ],
  exports: [GameService, RoomRegistryService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module metadata container.
export class GameEngineModule {}
