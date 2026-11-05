import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { DataSource } from "typeorm";
import {
  createDataSource,
  domainSchemas,
  migrateDatabase,
  SettingsRepository,
  UsersRepository,
  AuthRepository,
  QuizzesRepository,
  MediaRepository,
  RuntimeRepository,
  JobsRepository,
  ReportsRepository,
  OperationsRepository,
  AuditRepository,
} from "@kabuki-neko/database";
import { ConfigService } from "../../config/config.service";

export async function initializeDatabase(config: ConfigService): Promise<DataSource> {
  let source: DataSource | undefined;
  try {
    const driver = config.get("DB_DRIVER");
    const url = config.get("DATABASE_URL");
    source = createDataSource(
      {
        driver,
        sqlitePath: config.get("SQLITE_PATH"),
        ...(url ? { url } : {}),
        poolMax: config.get("DB_POOL_MAX"),
      },
      domainSchemas(driver),
    );
    await source.initialize();
    await migrateDatabase(source, config.get("DB_AUTO_MIGRATE"));
    return source;
  } catch {
    if (source?.isInitialized) await source.destroy().catch(() => undefined);
    // Never attach driver errors/causes, which can contain connection credentials.
    throw new Error("Database initialization failed");
  }
}
@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DataSource) private readonly source: DataSource) {}
  async onApplicationShutdown() {
    if (this.source.isInitialized) {
      try {
        await this.source.destroy();
      } catch {
        throw new Error("Database shutdown failed");
      }
    }
  }
}
const repositories = [
  SettingsRepository,
  UsersRepository,
  AuthRepository,
  QuizzesRepository,
  MediaRepository,
  RuntimeRepository,
  JobsRepository,
  ReportsRepository,
  OperationsRepository,
  AuditRepository,
];
@Global()
@Module({
  providers: [
    { provide: DataSource, inject: [ConfigService], useFactory: initializeDatabase },
    DatabaseLifecycle,
    ...repositories.map((repository) => ({
      provide: repository,
      inject: [DataSource],
      useFactory: (source: DataSource) => new repository(source),
    })),
  ],
  exports: [DataSource, ...repositories],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module metadata container.
export class DatabaseModule {}
