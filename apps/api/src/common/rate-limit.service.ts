import { createHash, randomUUID } from "node:crypto";
import type { Redis, Cluster } from "ioredis";
import { ApiError } from "./error.filter";

export const RATE_TIERS = {
  PUBLIC: [[60, 60000]],
  AUTH: [[10, 60000]],
  AUTH_EMAIL: [[5, 60000]],
  READ: [[120, 60000]],
  WRITE: [[30, 60000]],
  UPLOAD: [[10, 60000]],
  EXPORT: [[10, 60000]],
  ADMIN: [[30, 60000]],
  CLEANUP: [[1, 60000]],
  CHECK_JOIN: [[10, 60000]],
  FRIENDLY: [[10, 60000]],
  HOST: [[30, 60000]],
  CREATE: [[5, 60000]],
  ANSWER: [
    [5, 1000],
    [30, 60000],
  ],
  SYNC: [[12, 60000]],
  AVATAR: [[10, 60000]],
  TIME: [[12, 60000]],
} as const;
export type RateTier = keyof typeof RATE_TIERS;
const slidingScript = `
local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local retry=0
for i,key in ipairs(KEYS) do
 local limit=tonumber(ARGV[i*2]);local window=tonumber(ARGV[i*2+1])
 redis.call('ZREMRANGEBYSCORE',key,'-inf',now-window)
 if redis.call('ZCARD',key)>=limit then
  local first=redis.call('ZRANGE',key,0,0,'WITHSCORES')
  retry=math.max(retry,tonumber(first[2])+window-now)
 end
end
if retry>0 then return retry end
for i,key in ipairs(KEYS) do
 redis.call('ZADD',key,now,ARGV[1]);redis.call('PEXPIRE',key,tonumber(ARGV[i*2+1]))
end
return 0`;
const leaseScript = `
local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
if ARGV[1]=='release' then return redis.call('ZREM',KEYS[1],ARGV[2]) end
if ARGV[1]=='renew' and not redis.call('ZSCORE',KEYS[1],ARGV[2]) then return 0 end
if ARGV[1]=='acquire' and redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[3]) then return 0 end
redis.call('ZADD',KEYS[1],now+tonumber(ARGV[4]),ARGV[2]);redis.call('PEXPIRE',KEYS[1],tonumber(ARGV[4]));return 1`;
export interface ConcurrencyLease {
  renew(): Promise<void>;
  release(): Promise<void>;
}
export class RateLimitService {
  private readonly windows = new Map<string, number[]>();
  private readonly leases = new Map<string, Map<string, number>>();
  private nextSweep = 0;
  constructor(
    private readonly redis: Redis | Cluster | null = null,
    private readonly namespace = "default",
    private readonly clock: () => number = Date.now,
  ) {}
  private key(tier: string, principal: string): string {
    return `kabukineko:{limiter:${this.namespace}}:${tier}:${createHash("sha256").update(principal).digest("hex")}`;
  }
  private sweep(now: number): void {
    if (now < this.nextSweep) return;
    this.nextSweep = now + 60000;
    for (const [key, values] of this.windows)
      if ((values.at(-1) ?? 0) <= now - 60000) this.windows.delete(key);
    for (const [key, values] of this.leases) {
      for (const [id, expiry] of values) if (expiry <= now) values.delete(id);
      if (!values.size) this.leases.delete(key);
    }
  }
  private async eval(script: string, keys: string[], args: (string | number)[]): Promise<number> {
    try {
      if (!this.redis) throw new Error("Missing limiter connection");
      const result: unknown = await this.redis.eval(script, keys.length, ...keys, ...args);
      if (typeof result !== "number" || !Number.isFinite(result))
        throw new Error("Invalid limiter response");
      return result;
    } catch {
      throw new ApiError("DEPENDENCY_UNAVAILABLE", 503);
    }
  }
  async consume(tier: RateTier, principal: string): Promise<void> {
    const rules = RATE_TIERS[tier];
    const keys = rules.map(([, window]) => this.key(`${tier}:${window}`, principal));
    let retry = 0;
    if (this.redis)
      retry = await this.eval(slidingScript, keys, [
        randomUUID(),
        ...rules.flatMap(([limit, window]) => [limit, window]),
      ]);
    else {
      const now = this.clock();
      this.sweep(now);
      if (this.windows.size >= 100000 && keys.some((key) => !this.windows.has(key)))
        throw new ApiError("DEPENDENCY_UNAVAILABLE", 503);
      const buckets = rules.map(([limit, window], i) => {
        const key = keys[i];
        if (!key) throw new Error("Missing limiter key");
        const values = (this.windows.get(key) ?? []).filter((time) => time > now - window);
        this.windows.set(key, values);
        if (values.length >= limit) retry = Math.max(retry, (values[0] ?? now) + window - now);
        return values;
      });
      if (!retry) for (const bucket of buckets) bucket.push(now);
    }
    if (retry > 0) throw new ApiError("RATE_LIMITED", 429, { retryAfterMs: retry });
  }
  async acquire(kind: "UPLOAD" | "CLEANUP", principal: string): Promise<ConcurrencyLease> {
    const key = this.key(`concurrency:${kind}`, principal),
      token = randomUUID();
    const maximum = kind === "UPLOAD" ? 2 : 1,
      ttl = 120000;
    const operate = async (operation: "acquire" | "renew" | "release") => {
      if (this.redis) return this.eval(leaseScript, [key], [operation, token, maximum, ttl]);
      const now = this.clock();
      this.sweep(now);
      const bucket = this.leases.get(key) ?? new Map<string, number>();
      for (const [id, expiry] of bucket) if (expiry <= now) bucket.delete(id);
      if (operation === "release") {
        const removed = bucket.delete(token);
        if (!bucket.size) this.leases.delete(key);
        return Number(removed);
      }
      if (operation === "renew" && !bucket.has(token)) return 0;
      if (operation === "acquire" && bucket.size >= maximum) return 0;
      if (this.leases.size >= 100000 && !this.leases.has(key))
        throw new ApiError("DEPENDENCY_UNAVAILABLE", 503);
      bucket.set(token, now + ttl);
      this.leases.set(key, bucket);
      return 1;
    };
    if (!(await operate("acquire"))) throw new ApiError("RATE_LIMITED", 429, { retryAfterMs: ttl });
    return {
      renew: async () => {
        if (!(await operate("renew"))) throw new ApiError("DEPENDENCY_UNAVAILABLE", 503);
      },
      release: async () => {
        await operate("release");
      },
    };
  }
}
