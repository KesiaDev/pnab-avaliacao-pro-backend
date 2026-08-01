import { loadEnv } from "../shared/env.js";
import { createLogger } from "../observability/logger.js";
import { createUserScopedClient } from "../integrations/supabase.js";
import { createInternalApiClient } from "../integrations/internal-api.js";
import { createRedisConnection } from "../integrations/redis.js";
import { createSupabaseJwksResolver } from "../security/jwt.js";
import { createApplicationQueue, stageJobOptions } from "../shared/applicationQueue.js";
import { createDriveSyncQueue, driveSyncJobOptions } from "../shared/driveSyncQueue.js";
import { PIPELINE_STAGES } from "../shared/queueNames.js";
import { buildServer } from "./server.js";

const env = loadEnv();
const logger = createLogger(env);
const redis = createRedisConnection(env);
const queue = createApplicationQueue(redis);
const syncQueue = createDriveSyncQueue(redis);
const internalApi = createInternalApiClient(env);
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
    // RLS decide sozinha se a linha existe e é visível pro usuário -- não há
    // organizations/workspaces nesta plataforma (tenancy única, ver ADR
    // revisado no plano); a visibilidade da linha via RLS já é a autorização.
    findApplicationEdital: async (applicationId, accessToken) => {
      const userClient = createUserScopedClient(env, accessToken);
      const { data } = await userClient
        .from("proponents")
        .select("edital_id")
        .eq("id", applicationId)
        .maybeSingle();
      if (!data?.edital_id) return null;
      return { editalId: data.edital_id as string };
    },
    // A criação do job em si é escrita privilegiada (processing_jobs/
    // job_stages) -- passa pelo endpoint interno HMAC do app web, não pelo
    // Postgres direto (ver integrations/internal-api.ts).
    createProcessingJob: async ({ editalId, applicationId, triggeredBy }) => {
      return internalApi.createJob({ editalId, applicationId, triggeredBy });
    },
    enqueueFirstStage: async ({ jobId, editalId, applicationId }) => {
      const firstStage = PIPELINE_STAGES[0];
      await queue.add(
        firstStage,
        { jobId, editalId, applicationId, stage: firstStage },
        { jobId: `${jobId}:${firstStage}`, ...stageJobOptions(env.MAX_STAGE_ATTEMPTS) },
      );
    },
  },
  drive: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: env.GOOGLE_REDIRECT_URI,
    },
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    frontendOrigin: env.FRONTEND_ORIGIN,
    internalApi,
    findActiveConnection: async (accessToken) => {
      const userClient = createUserScopedClient(env, accessToken);
      const { data } = await userClient
        .from("drive_connections")
        .select("id, refresh_token_encrypted")
        .is("revoked_at", null)
        .order("connected_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data
        ? {
            id: data.id as string,
            refreshTokenEncryptedHex: data.refresh_token_encrypted as string,
          }
        : null;
    },
    findDriveSourceForEdital: async (editalId, accessToken) => {
      const userClient = createUserScopedClient(env, accessToken);
      const { data } = await userClient
        .from("drive_sources")
        .select("id")
        .eq("edital_id", editalId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data ? { id: data.id as string } : null;
    },
    findActiveSyncRun: async (driveSourceId, accessToken) => {
      const userClient = createUserScopedClient(env, accessToken);
      const { data } = await userClient
        .from("sync_runs")
        .select("id")
        .eq("drive_source_id", driveSourceId)
        .eq("status", "em_andamento")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data ? { id: data.id as string } : null;
    },
    enqueueSync: async ({ syncRunId, driveSourceId, editalId, refreshTokenEncryptedHex }) => {
      await syncQueue.add(
        "sync",
        { syncRunId, driveSourceId, editalId, refreshTokenEncryptedHex },
        { jobId: syncRunId, ...driveSyncJobOptions(env.MAX_STAGE_ATTEMPTS) },
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
    await syncQueue.close();
    await redis.quit();
    process.exit(0);
  });
}
