import { randomUUID } from "node:crypto";
import { loadEnv } from "../shared/env.js";
import { createLogger } from "../observability/logger.js";
import { createServiceRoleClient, createUserScopedClient } from "../integrations/supabase.js";
import { createRedisConnection } from "../integrations/redis.js";
import { createSupabaseJwksResolver } from "../security/jwt.js";
import { createApplicationQueue, stageJobOptions } from "../shared/applicationQueue.js";
import { buildServer } from "./server.js";

const env = loadEnv();
const logger = createLogger(env);
const redis = createRedisConnection(env);
const queue = createApplicationQueue(redis);
const serviceClient = createServiceRoleClient(env);
const getKey = createSupabaseJwksResolver(env.SUPABASE_JWKS_URL);

const server = buildServer({
  logger,
  appVersion: env.APP_VERSION,
  frontendOrigin: env.FRONTEND_ORIGIN,
  jwt: { getKey, issuer: env.SUPABASE_JWT_ISSUER },
  checkReady: async () => {
    try {
      const pong = await redis.ping();
      return pong === "PONG";
    } catch {
      return false;
    }
  },
  jobs: {
    // RLS decide sozinha se a linha existe pra este usuário — não precisa de
    // lógica extra de autorização aqui (ver ADR-4).
    verifyMembership: async (userId, workspaceId, accessToken) => {
      const userClient = createUserScopedClient(env, accessToken);
      const { data } = await userClient
        .from("workspace_members")
        .select("user_id")
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId)
        .maybeSingle();
      return data != null;
    },
    createProcessingJob: async ({ workspaceId, applicationId, createdBy }) => {
      const jobId = randomUUID();
      const { error } = await serviceClient.from("processing_jobs").insert({
        id: jobId,
        workspace_id: workspaceId,
        application_id: applicationId,
        status: "queued",
        created_by: createdBy,
      });
      if (error) throw new Error(`Não foi possível criar o job: ${error.message}`);
      return { jobId };
    },
    enqueueStage: async ({ jobId, workspaceId, applicationId, stageName, payload }) => {
      await queue.add(
        stageName,
        { jobId, workspaceId, applicationId, stageName, payload },
        { jobId, ...stageJobOptions(env.MAX_STAGE_ATTEMPTS) },
      );
    },
  },
});

server
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .then(() => logger.info({ port: env.PORT }, "api_listening"))
  .catch((err) => {
    logger.error({ err }, "api_start_failed");
    process.exit(1);
  });

// Graceful shutdown: fecha o server HTTP e a conexão Redis antes de sair,
// pra não derrubar request em andamento nem deixar conexão pendurada.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, "api_shutting_down");
    await server.close();
    await redis.quit();
    process.exit(0);
  });
}
