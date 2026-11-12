/**
 * `pnpm deploy:scale` / `tsx scripts/start-profile.ts [default|scale] [compose args…]`: starts a
 * Kabuki Neko Compose profile with exactly the documented command (TASK-176; SA §10.2; US-16/17).
 *
 * - `scale` (the default of `pnpm deploy:scale`): sets DEPLOYMENT_PROFILE=scale for the API (which
 *   selects the postgres/redis/s3 drivers) and passes `--profile scale` (which starts PostgreSQL,
 *   Redis, MinIO and their init jobs). The two always go together, so the API never runs with
 *   scale drivers but no services, nor the other way round.
 * - `default`: one web and one API container with SQLite, memory state and local uploads.
 * - Extra arguments replace the Compose action. The default action is `up -d --build`; for
 *   example `pnpm deploy:scale config --quiet` validates and `pnpm deploy:scale down` stops.
 * - The bundled MinIO talks plain HTTP inside the private Compose network, which production
 *   configuration refuses unless ALLOW_INSECURE_LOCAL_HTTP=true. When the variable is unset the
 *   wrapper sets it for the scale profile and says so; an explicit value (true or false) is kept.
 *   Put HTTPS in front of every browser-facing URL (docs/deployment.md).
 * - Docker runs with an argument array and no shell; the printed command contains no secrets
 *   (they are generated inside the Compose secrets volume). The exit code is Docker's.
 */
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
/** The Compose file both profiles use. */
export const COMPOSE_FILE = path.join("docker", "docker-compose.yml");

/** A profile and the exact command plus environment that start it. */
export interface ProfileCommand {
  env: Record<string, string>;
  args: string[];
  notices: string[];
}

/** Builds the Compose invocation for `profile` (pure, for tests and `--print`). */
export function profileCommand(
  profile: "default" | "scale",
  action: string[],
  environment: NodeJS.ProcessEnv = process.env,
): ProfileCommand {
  const env: Record<string, string> = { DEPLOYMENT_PROFILE: profile };
  const notices: string[] = [];
  const args = ["compose", "-f", COMPOSE_FILE];
  if (profile === "scale") {
    args.push("--profile", "scale");
    if (environment["ALLOW_INSECURE_LOCAL_HTTP"] === undefined) {
      env["ALLOW_INSECURE_LOCAL_HTTP"] = "true";
      notices.push(
        "ALLOW_INSECURE_LOCAL_HTTP=true: the bundled MinIO uses HTTP inside the private Compose network; serve every public URL over HTTPS.",
      );
    }
  }
  args.push(...(action.length > 0 ? action : ["up", "-d", "--build"]));
  return { env, args, notices };
}

/** CLI entry: parse the profile, print the exact command, run Docker, forward its exit code. */
function main() {
  const [first, ...rest] = process.argv.slice(2);
  const profile = first === "default" || first === "scale" ? first : "scale";
  const action = first === "default" || first === "scale" ? rest : process.argv.slice(2);
  const command = profileCommand(profile, action);
  for (const notice of command.notices) process.stderr.write(`deploy: ${notice}\n`);
  const shown = Object.entries(command.env)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  process.stdout.write(`deploy: ${shown} docker ${command.args.join(" ")}\n`);
  const child = spawn("docker", command.args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...command.env },
  });
  child.on("error", (error) => {
    process.stderr.write(`deploy: cannot run docker: ${error.message}\n`);
    process.exitCode = 2;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (require.main === module) main();
