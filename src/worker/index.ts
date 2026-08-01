import { Worker, Queue } from "bullmq";
import { loadEnv } from "../shared/env.js";
import { createLogger } from "../observability/logger.js";
import { createInternalApiClient } from "../integrations/internal-api.js";
import { createRedisConnection } from "../integrations/redis.js";
import { APPLICATION_PROCESSING_QUEUE, APPLICATION_PROCESSING_DLQ } from "../shared/queueNames.js";
import type { ApplicationStageJobData } from "../shared/applicationQueue.js";
import { stageJobOptions } from "../shared/applicationQueue.js";
import { DRIVE_SYNC_QUEUE, type DriveSyncJobData } from "../shared/driveSyncQueue.js";
import { decryptRefreshToken, pgByteaToBuffer } from "../security/tokenEncryption.js";
import { refreshAccessToken } from "../integrations/googleOAuth.js";
import { processStageJob } from "./processStageJob.js";
import { processSyncJob } from "./processSyncJob.js";

const env = loadEnv();
const logger = createLogger(env);
const redis = createRedisConnection(env);
const internalApi = createInternalApiClient(env);
const queue = new Queue<ApplicationStageJobData>(APPLICATION_PROCESSING_QUEUE, { connection: redis });
const dlq = new Queue<ApplicationStageJobData>(APPLICATION_PROCESSING_DLQ, { connection: redis });

const worker = new Worker<ApplicationStageJobData>(
  APPLICATION_PROCESSING_QUEUE,
  async (job) => {
    const jobLogger = logger.child({
      jobId: job.data.jobId,
      stage: job.data.stage,
      applicationId: job.data.applicationId,
    });
    await processStageJob(job.data, job.attemptsMade + 1, {
      logger: jobLogger,
      reportStageState: async (input) => {
        await internalApi.updateStage({
          jobId: input.jobId,
          stage: input.stage,
          state: input.state,
          attempts: input.attempts,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          retryable: input.retryable,
          ...(input.state === "processando" ? { startedAt: new Date().toISOString() } : {}),
          ...(input.state !== "processando" ? { finishedAt: new Date().toISOString() } : {}),
        });
      },
      enqueueNextStage: async (input) => {
        await queue.add(
          input.stage,
          { jobId: input.jobId, editalId: input.editalId, applicationId: input.applicationId, stage: input.stage },
          // BullMQ rejeita ":" no id do job ("Custom Id cannot contain :").
          { jobId: `${input.jobId}-${input.stage}`, ...stageJobOptions(env.MAX_STAGE_ATTEMPTS) },
        );
      },
      internalApi,
    });
  },
  { connection: redis, concurrency: env.MAX_CONCURRENT_APPLICATIONS },
);

worker.on("completed", (job) => {
  logger.info({ jobId: job.data.jobId, stage: job.data.stage }, "stage_completed");
});

// Só move pra dead-letter depois de esgotadas as tentativas configuradas em
// stageJobOptions -- nunca perde silenciosamente uma etapa que falhou de
// vez, e a última gravação em job_stages já registrou "falhou" via
// reportStageState (Realtime do frontend já reflete isso).
worker.on("failed", async (job, err) => {
  if (!job) return;
  const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
  logger.error(
    { jobId: job.data.jobId, stage: job.data.stage, attemptsMade: job.attemptsMade, exhausted, err },
    "stage_failed",
  );
  if (!exhausted) return;
  await dlq.add(job.data.stage, job.data, { jobId: `${job.data.jobId}-${job.data.stage}-dlq` });
});

const syncWorker = new Worker<DriveSyncJobData>(
  DRIVE_SYNC_QUEUE,
  async (job) => {
    const jobLogger = logger.child({ syncRunId: job.data.syncRunId, editalId: job.data.editalId });
    await processSyncJob(job.data, {
      logger: jobLogger,
      getGoogleAccessToken: async (refreshTokenEncryptedHex) => {
        const refreshToken = decryptRefreshToken(
          pgByteaToBuffer(refreshTokenEncryptedHex),
          env.TOKEN_ENCRYPTION_KEY,
        );
        const { access_token } = await refreshAccessToken(env, refreshToken);
        return access_token;
      },
      executeSyncRun: async (input) => internalApi.executeSyncRun(input),
      finishSyncRun: async (input) => {
        await internalApi.finishSyncRun(input);
      },
    });
  },
  { connection: redis, concurrency: env.MAX_CONCURRENT_APPLICATIONS },
);

syncWorker.on("completed", (job) => {
  logger.info({ syncRunId: job.data.syncRunId }, "sync_completed");
});
syncWorker.on("failed", (job, err) => {
  logger.error({ syncRunId: job?.data.syncRunId, err }, "sync_failed");
});

logger.info({ concurrency: env.MAX_CONCURRENT_APPLICATIONS }, "worker_listening");

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, "worker_shutting_down");
    await worker.close();
    await syncWorker.close();
    await queue.close();
    await dlq.close();
    await redis.quit();
    process.exit(0);
  });
}
