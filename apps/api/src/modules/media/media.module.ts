/**
 * Media module: upload/library/metadata/delete REST routes, the shared reference protocol, safe
 * deletion + orphan cleanup, and the background janitor. `MediaGcService` and `MediaService` are
 * exported so the system module can expose storage cleanup and metrics without duplicating rules.
 */
import {
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { CommonModule } from "../../common/common.module";
import { MediaGcService } from "./media-gc.service";
import { MediaController } from "./media.controller";
import { MediaReferenceService } from "./media-reference.service";
import { MediaService } from "./media.service";

/** How often each API instance sweeps interrupted uploads and crashed deletions. */
export const JANITOR_INTERVAL_MS = 5 * 60_000;

/**
 * Runs `MediaGcService.sweep()` once at startup and then every five minutes. Sweeps never
 * overlap within an instance; across instances every step is row-locked and idempotent.
 */
@Injectable()
export class MediaJanitor implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  constructor(@Inject(MediaGcService) private readonly gc: MediaGcService) {}

  /** Starts the unref'd interval and the first sweep. */
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), JANITOR_INTERVAL_MS);
    this.timer.unref();
    void this.tick();
  }
  /** One sweep; failures are retried on the next interval rather than crashing the process. */
  tick(): Promise<void> {
    this.running ??= this.gc
      .sweep()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  /** Stops the interval and waits for an in-flight sweep before the database closes. */
  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }
}

@Module({
  imports: [CommonModule],
  controllers: [MediaController],
  providers: [MediaReferenceService, MediaService, MediaGcService, MediaJanitor],
  exports: [MediaService, MediaGcService, MediaReferenceService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module metadata container.
export class MediaModule {}
