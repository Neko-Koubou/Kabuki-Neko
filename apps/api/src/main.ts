import { configureUploads } from "./providers/storage/storage.module";
import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ConfigService } from "./config/config.service";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { abortOnError: false });
  try {
    const config = app.get(ConfigService);
    app.setGlobalPrefix("api/v1");
    configureUploads(app);
    app.enableShutdownHooks();
    await app.listen(config.get("API_PORT"), "0.0.0.0");
  } catch (error) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch(() => {
  Logger.error("API startup failed", "Bootstrap");
  process.exitCode = 1;
});
