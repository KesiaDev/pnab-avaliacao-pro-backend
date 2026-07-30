import { Redis } from "ioredis";
import type { Env } from "../shared/env.js";

// maxRetriesPerRequest: null é exigido pelo BullMQ (blocking commands do
// worker não podem ter retry limitado pela lib do Redis, quem controla é o
// próprio BullMQ). Ver docs do BullMQ sobre "Connections".
export function createRedisConnection(env: Pick<Env, "REDIS_URL">): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}
