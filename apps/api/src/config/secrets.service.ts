import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type RuntimeEnvironment, secretValueSchema } from "./env.schema";

const runtimeSecretsSchema = z
  .strictObject({ accessSecret: secretValueSchema, refreshSecret: secretValueSchema })
  .refine((value) => value.accessSecret !== value.refreshSecret);
const persistedSecretsSchema = runtimeSecretsSchema.safeExtend({ version: z.literal(1) });
export type RuntimeSecrets = z.infer<typeof runtimeSecretsSchema>;
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
async function readSecrets(filename: string): Promise<RuntimeSecrets | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    // eslint-disable-next-line preserve-caught-error -- Filesystem causes may expose operator-supplied secret paths; startup errors are intentionally redacted.
    throw new Error("Runtime secret file cannot be opened");
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 8192 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Invalid runtime secret file metadata");
    const stored = persistedSecretsSchema.safeParse(
      JSON.parse(await handle.readFile("utf8")) as unknown,
    );
    if (!stored.success) throw new Error("Invalid runtime secret file");
    return { accessSecret: stored.data.accessSecret, refreshSecret: stored.data.refreshSecret };
  } catch {
    throw new Error("Invalid runtime secret file");
  } finally {
    await handle.close();
  }
}
async function initializeSecrets(filename: string): Promise<RuntimeSecrets> {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.runtime-secrets-${randomBytes(16).toString("hex")}.tmp`);
  const data = {
    version: 1,
    accessSecret: randomBytes(64).toString("hex"),
    refreshSecret: randomBytes(64).toString("hex"),
  };
  let created = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(JSON.stringify(data) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, filename);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    // link publishes a complete fsynced inode without ever replacing an existing secret.
    const parent = await open(directory, constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    const winner = await readSecrets(filename);
    if (!winner) throw new Error("Runtime secrets were not persisted");
    return winner;
  } catch {
    throw new Error("Runtime secret initialization failed");
  } finally {
    if (created) await unlink(temporary);
  }
}
export class SecretsService {
  async load(env: RuntimeEnvironment): Promise<RuntimeSecrets> {
    if (env.JWT_ACCESS_SECRET && env.JWT_REFRESH_SECRET)
      return Object.freeze(
        runtimeSecretsSchema.parse({
          accessSecret: env.JWT_ACCESS_SECRET,
          refreshSecret: env.JWT_REFRESH_SECRET,
        }),
      );
    let stored = await readSecrets(env.APP_SECRET_FILE);
    if (!stored) {
      if (env.DEPLOYMENT_TOPOLOGY === "multi")
        throw new Error("Multi-instance deployment requires shared pre-provisioned secrets");
      stored = await initializeSecrets(env.APP_SECRET_FILE);
    }
    const result = runtimeSecretsSchema.safeParse({
      accessSecret: env.JWT_ACCESS_SECRET ?? stored.accessSecret,
      refreshSecret: env.JWT_REFRESH_SECRET ?? stored.refreshSecret,
    });
    if (!result.success) throw new Error("Runtime secrets must be distinct valid values");
    return Object.freeze(result.data);
  }
}
