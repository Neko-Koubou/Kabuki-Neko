import { StorageModule } from "./providers/storage/storage.module";
import { DatabaseModule } from "./providers/database/database.module";
import { Global, Module } from "@nestjs/common";
import { ConfigService } from "./config/config.service";
import { parseEnvironment } from "./config/env.schema";
import { SecretsService } from "./config/secrets.service";

@Global()
@Module({
  providers: [
    SecretsService,
    {
      provide: ConfigService,
      inject: [SecretsService],
      useFactory: async (secrets: SecretsService): Promise<ConfigService> => {
        const environment = parseEnvironment(process.env);
        return new ConfigService(environment, await secrets.load(environment));
      },
    },
  ],
  exports: [ConfigService, SecretsService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest modules are decorator metadata containers.
export class RuntimeConfigModule {}

@Module({ imports: [RuntimeConfigModule, DatabaseModule, StorageModule] })
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest modules are decorator metadata containers.
export class AppModule {}
