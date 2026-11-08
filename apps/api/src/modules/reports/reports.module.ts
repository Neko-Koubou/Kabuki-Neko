/**
 * Reports module: REST routes, the freeze-to-queue finalizer, the durable queue worker and their
 * wiring into the game engine (SA §4.5, §6.3).
 *
 * `ReportsWiring` installs typed callbacks at module init, so neither the engine nor the scheduler
 * imports this module (no DI cycle):
 * - report hook: a frozen report is enqueued durably (`ReportFinalizer.enqueue`);
 * - finalization sync: the scheduler re-drives non-ready frozen reports (`ReportWorker.sync`);
 * - status listener: after the worker's SQL commit (or a failure) the room is re-published through
 *   the notifying game service, whose gateway diff emits `report:status_changed` to the host room
 *   only — with the stable reportId (= sessionId) exclusively once the history is committed.
 * The worker itself starts on application bootstrap and stops (awaiting running jobs) on shutdown.
 */
import {
  Inject,
  Injectable,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { CommonModule } from "../../common/common.module";
import { StateModule } from "../../providers/state/state.module";
import { GameEngineModule } from "../game-engine/game-engine.module";
import { GameService } from "../game-engine/game.service";
import { ReportFinalizer } from "./report-finalizer";
import { ReportWorker } from "./report-worker";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

/** Connects the engine's typed callbacks to the finalizer and worker for the app lifetime. */
@Injectable()
export class ReportsWiring implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(GameService) private readonly game: GameService,
    @Inject(ReportFinalizer) private readonly finalizer: ReportFinalizer,
    @Inject(ReportWorker) private readonly worker: ReportWorker,
  ) {}

  /** Installs the report hook, the scheduler sync callback and the host status listener. */
  onModuleInit(): void {
    this.game.setReportHook(async (identity, report) => {
      await this.finalizer.enqueue(identity, report);
    });
    this.game.setFinalizationSync(async (identity, report, current) => {
      await this.worker.sync(identity, report, current);
    });
    this.worker.setStatusListener(async (identity) => {
      // A tick on a final room only performs due CAS transitions, then publishes the diff
      // (including the new finalization status) to the host room.
      if (identity) await this.game.tick(identity).catch(() => undefined);
    });
  }
  /** Removes the callbacks so a closing app never enqueues through a destroyed module. */
  onModuleDestroy(): void {
    this.game.setReportHook(null);
    this.game.setFinalizationSync(null);
    this.worker.setStatusListener(null);
  }
}

@Module({
  imports: [CommonModule, StateModule, GameEngineModule],
  controllers: [ReportsController],
  providers: [ReportFinalizer, ReportWorker, ReportsService, ReportsWiring],
  exports: [ReportsService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module metadata container.
export class ReportsModule {}
