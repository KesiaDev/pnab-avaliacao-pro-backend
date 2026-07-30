import { randomUUID } from "node:crypto";
import { Worker, Queue } from "bullmq";
import { loadEnv } from "../shared/env.js";
import { createLogger } from "../observability/logger.js";
import { createServiceRoleClient } from "../integrations/supabase.js";
import { createRedisConnection } from "../integrations/redis.js";
import { APPLICATION_PROCESSING_QUEUE, APPLICATION_PROCESSING_DLQ } from "../shared/queueNames.js";
import type { ApplicationStageJobData } from "../shared/applicationQueue.js";
import { processStageJob } from "./processStageJob.js";

const env = loadEnv();
const logger = createLogger(env);
const redis = createRedisConnection(env);
const supabase = createServiceRoleClient(env);
const dlq = new Queue<ApplicationStageJobData>(APPLICATION_PROCESSING_DLQ, { connection: redis });

const worker = new Worker<ApplicationStageJobData>(
  APPLICATION_PROCESSING_QUEUE,
  async (job) => {
    const jobLogger = logger.child({
      jobId: job.data.jobId,
      stageId: job.id,
      applicationId: job.data.applicationId,
    });
    await processStageJob(job.data, {
      logger: jobLogger,
      fetchPastAttempts: async (jobId, stageName) => {
        const { data, error } = await supabase
          .from("stage_attempts")
          .select("input_hash, status")
          .eq("processing_job_id", jobId)
          .eq("stage_name", stageName);
        if (error) throw new Error(`Falha ao consultar tentativas anteriores: ${error.message}`);
        return (data ?? []).map((row) => ({
          inputHash: row.input_hash as string,
          status: row.status as "concluido" | "erro" | "em_andamento",
        }));
      },
      recordAttemptStart: async (jobId, stageName, inputHash) => {
        const attemptId = randomUUID();
        const { error } = await supabase.from("stage_attempts").insert({
          id: attemptId,
          processing_job_id: jobId,
          stage_name: stageName,
          input_hash: inputHash,
          status: "em_andamento",
          attempt_number: job.attemptsMade + 1,
        });
        if (error) throw new Error(`Falha ao registrar tentativa: ${error.message}`);
        return { attemptId };
      },
      recordAttemptResult: async (attemptId, result) => {
        const { error } = await supabase
          .from("stage_attempts")
          .update({
            status: result.status,
            output: result.output ?? null,
            error_message: result.errorMessage ?? null,
            finished_at: new Date().toISOString(),
          })
          .eq("id", attemptId);
        if (error) throw new Error(`Falha ao gravar resultado da tentativa: ${error.message}`);
      },
      markJobStatus: async (jobId, status) => {
        const { error } = await supabase.from("processing_jobs").update({ status }).eq("id", jobId);
        if (error) throw new Error(`Falha ao atualizar status do job: ${error.message}`);
      },
    });
  },
  { connection: redis, concurrency: env.MAX_CONCURRENT_APPLICATIONS },
);

worker.on("completed", (job) => {
  logger.info({ jobId: job.data.jobId, stageName: job.data.stageName }, "stage_completed");
});

// Só move pra dead-letter depois de esgotadas as tentativas configuradas em
// stageJobOptions (ver ADR: nunca repetir etapa concluída, mas também nunca
// perder silenciosamente uma etapa que falhou de vez).
worker.on("failed", async (job, err) => {
  if (!job) return;
  const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
  logger.error(
    { jobId: job.data.jobId, stageName: job.data.stageName, attemptsMade: job.attemptsMade, exhausted, err },
    "stage_failed",
  );
  if (!exhausted) return;
  await dlq.add(job.data.stageName, job.data, { jobId: `${job.data.jobId}:${job.data.stageName}` });
  await supabase.from("processing_jobs").update({ status: "erro" }).eq("id", job.data.jobId);
});

logger.info({ concurrency: env.MAX_CONCURRENT_APPLICATIONS }, "worker_listening");

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, "worker_shutting_down");
    await worker.close();
    await dlq.close();
    await redis.quit();
    process.exit(0);
  });
}
