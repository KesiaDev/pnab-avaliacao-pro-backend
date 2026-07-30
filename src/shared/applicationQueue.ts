import { Queue, type ConnectionOptions } from "bullmq";
import type { Redis } from "ioredis";
import { APPLICATION_PROCESSING_QUEUE, type PipelineStage } from "./queueNames.js";

export interface ApplicationStageJobData {
  jobId: string;
  editalId: string;
  applicationId: string;
  stage: PipelineStage;
}

export function createApplicationQueue(
  connection: Redis | ConnectionOptions,
): Queue<ApplicationStageJobData> {
  return new Queue<ApplicationStageJobData>(APPLICATION_PROCESSING_QUEUE, { connection });
}

// Config de retry/backoff compartilhada entre quem enfileira (API) e o que o
// Worker espera — mantém MAX_STAGE_ATTEMPTS como fonte única da verdade.
export function stageJobOptions(maxStageAttempts: number) {
  return {
    attempts: maxStageAttempts,
    backoff: { type: "exponential" as const, delay: 2000 },
    removeOnComplete: { age: 60 * 60 * 24 * 7 },
    removeOnFail: false,
  };
}
