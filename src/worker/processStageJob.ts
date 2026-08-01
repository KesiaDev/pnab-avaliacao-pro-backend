import type { Logger } from "../observability/logger.js";
import type { InternalApiClient } from "../integrations/internal-api.js";
import { getStageHandler } from "./stageRegistry.js";
import { PIPELINE_STAGES, type PipelineStage } from "../shared/queueNames.js";
import type { ApplicationStageJobData } from "../shared/applicationQueue.js";

export function getNextStage(stage: PipelineStage): PipelineStage | undefined {
  const currentIndex = PIPELINE_STAGES.indexOf(stage);
  return PIPELINE_STAGES[currentIndex + 1];
}

export interface ProcessStageDeps {
  reportStageState: (input: {
    jobId: string;
    stage: PipelineStage;
    state: "processando" | "concluido" | "falhou";
    attempts: number;
    errorCode?: string;
    errorMessage?: string;
    retryable?: boolean;
  }) => Promise<void>;
  enqueueNextStage: (input: {
    jobId: string;
    editalId: string;
    applicationId: string;
    stage: PipelineStage;
  }) => Promise<void>;
  internalApi: InternalApiClient;
  logger: Logger;
}

// Núcleo do Worker, isolado do BullMQ de propósito -- testável sem Redis nem
// HTTP reais. O BullMQ só decide retry/backoff a partir do throw daqui.
// Idempotência aqui é por desenho do pipeline (Fase 2/3): cada estágio só
// avança pro próximo quando o anterior termina com sucesso, e um retry
// explícito de etapa (jobsApi.retryStage, no app web) é uma ação deliberada
// do usuário -- não algo que este Worker deva tentar adivinhar/bloquear.
export async function processStageJob(
  data: ApplicationStageJobData,
  attemptsMade: number,
  deps: ProcessStageDeps,
): Promise<void> {
  await deps.reportStageState({
    jobId: data.jobId,
    stage: data.stage,
    state: "processando",
    attempts: attemptsMade,
  });

  try {
    const handler = getStageHandler(data.stage);
    await handler({
      editalId: data.editalId,
      applicationId: data.applicationId,
      internalApi: deps.internalApi,
      logger: deps.logger,
    });

    await deps.reportStageState({
      jobId: data.jobId,
      stage: data.stage,
      state: "concluido",
      attempts: attemptsMade,
    });

    const nextStage = getNextStage(data.stage);
    if (nextStage) {
      await deps.enqueueNextStage({
        jobId: data.jobId,
        editalId: data.editalId,
        applicationId: data.applicationId,
        stage: nextStage,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.reportStageState({
      jobId: data.jobId,
      stage: data.stage,
      state: "falhou",
      attempts: attemptsMade,
      errorCode: "stage_execution_failed",
      errorMessage: message,
      retryable: true,
    });
    // Nunca engolir o erro aqui: é o throw que faz o BullMQ agendar o retry
    // com backoff (ver stageJobOptions).
    throw err;
  }
}
