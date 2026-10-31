import { parseEnvironment, type RuntimeEnvironment } from "./env.schema";
import { SecretsService, type RuntimeSecrets } from "./secrets.service";

/** Explicit async factory used by Nest DI; construction never connects to providers. */
export class ConfigService {
  constructor(
    readonly values: RuntimeEnvironment,
    readonly secrets: RuntimeSecrets,
  ) {}
  static async load(raw: Record<string, string | undefined> = process.env): Promise<ConfigService> {
    const values = parseEnvironment(raw);
    return new ConfigService(values, await new SecretsService().load(values));
  }
  get<K extends keyof RuntimeEnvironment>(key: K): RuntimeEnvironment[K] {
    return this.values[key];
  }
  /** A deliberate allowlist, so future secret settings cannot accidentally appear in logs. */
  toJSON() {
    const env = this.values;
    return {
      nodeEnv: env.NODE_ENV,
      profile: env.DEPLOYMENT_PROFILE,
      topology: env.DEPLOYMENT_TOPOLOGY,
      instanceId: env.DEPLOYMENT_INSTANCE_ID,
      apiPort: env.API_PORT,
      dbDriver: env.DB_DRIVER,
      stateDriver: env.STATE_DRIVER,
      storageDriver: env.STORAGE_DRIVER,
      maxActiveRooms: env.MAX_ACTIVE_ROOMS,
    };
  }
}
