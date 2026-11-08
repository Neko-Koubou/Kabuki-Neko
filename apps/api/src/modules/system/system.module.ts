/**
 * System module: health probes, settings and metrics, the installed locale registry, the audio
 * catalogue, About metadata and storage cleanup (delegated to the media module's GC service).
 * `InstalledLocales` is bound to the locale registry so settings validation always checks the
 * bundle the API actually serves.
 */
import { Module } from "@nestjs/common";
import { CommonModule } from "../../common/common.module";
import { StateModule } from "../../providers/state/state.module";
import { MediaModule } from "../media/media.module";
import { AudioCatalogService } from "./audio-catalog.service";
import { HealthService } from "./health.service";
import { LocaleRegistryService } from "./locale-registry.service";
import { SystemController } from "./system.controller";
import { InstalledLocales, SystemService } from "./system.service";

@Module({
  imports: [CommonModule, MediaModule, StateModule],
  controllers: [SystemController],
  providers: [
    LocaleRegistryService,
    { provide: InstalledLocales, useExisting: LocaleRegistryService },
    AudioCatalogService,
    HealthService,
    SystemService,
  ],
  exports: [SystemService, HealthService, LocaleRegistryService, AudioCatalogService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module metadata container.
export class SystemModule {}
