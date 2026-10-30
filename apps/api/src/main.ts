import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix("api/v1");
  app.enableShutdownHooks();
  const port = process.env["PORT"] === undefined ? 3001 : Number(process.env["PORT"]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    await app.close();
    throw new Error("Invalid API port");
  }
  await app.listen(port, "0.0.0.0");
}

void bootstrap().catch(() => {
  Logger.error("API startup failed", "Bootstrap");
  process.exitCode = 1;
});
