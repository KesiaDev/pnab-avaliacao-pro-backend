import type { Logger } from "../observability/logger.js";
import { stableHash } from "../domain/hash.js";
import { decideStageExecution, type PastStageAttempt } from "../domain/stageIdempotency.js";
import { getStageHandler } from "./stageRegistry.js";
import type { ApplicationStageJobData } from "../shared/applicationQueue.js";

export interface ProcessStageDeps {
  fetchPastAttempts: (jobId: string, stageName: string) => Promise<PastStageAttempt[]>;
  recordAttemptStart: (jobId: string, stageName: string, inputHash: string) => Promise<{ attemptId: string }>;
  recordAttemptResult: (
    attemptId: string,
    result: { status: "concluido" | "erro"; output?: unknown; errorMessage?: string },
  ) => Promise<void>;
  markJobStatus: (jobId: string, status: "concluido" | "erro") => Promise<void>;
  logger: Logger;
}

// Núcleo do Worker, isolado do BullMQ de propósito — testável sem Redis nem
// Supabase reais. O BullMQ só decide retry/backoff a partir do throw daqui;
// toda a lógica de idempotência (ADR-2) e registro de tentativa vive aqui.
export async function processStageJob(
  data: ApplicationStageJobData,
  deps: ProcessStageDeps,
): Promise<void> {
  const inputHash = stableHash({
    workspaceId: data.workspaceId,
    applicationId: data.applicationId,
    stageName: data.stageName,
    payload: data.payload,
  });

  const pastAttempts = await deps.fetchPastAttempts(data.jobId, data.stageName);
  const decision = decideStageExecution(pastAttempts, inputHash);
  if (decision.action === "skip") {
    deps.logger.info(
      { jobId: data.jobId, stageName: data.stageName },
      "stage_skipped_already_completed",
    );
    return;
  }

  const { attemptId } = await deps.recordAttemptStart(data.jobId, data.stageName, inputHash);
  try {
    const handler = getStageHandler(data.stageName);
    const output = await handler({
      workspaceId: data.workspaceId,
      applicationId: data.applicationId,
      payload: data.payload,
    });
    await deps.recordAttemptResult(attemptId, { status: "concluido", output });
    await deps.markJobStatus(data.jobId, "concluido");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.recordAttemptResult(attemptId, { status: "erro", errorMessage: message });
    // Nunca engolir o erro aqui: é o throw que faz o BullMQ agendar o retry
    // com backoff (ver stageJobOptions) e, esgotadas as tentativas, mover
    // pra dead-letter queue (ver worker/index.ts).
    throw err;
  }
}
