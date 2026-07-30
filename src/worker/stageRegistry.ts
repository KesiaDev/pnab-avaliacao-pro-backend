import type { PipelineStage } from "../shared/queueNames.js";
import { runNoopStage, type StageInput, type StageOutput } from "./stages/noop.js";

type StageHandler = (input: StageInput) => Promise<StageOutput>;

// Só "noop" está implementado nesta fase. Os demais nomes já existem no
// contrato (PIPELINE_STAGES) pra Fase 6/7 não precisar renomear nada — até
// lá, chamar um deles é um erro de programação, não um caso a tratar
// silenciosamente.
const registry: Partial<Record<PipelineStage, StageHandler>> = {
  noop: runNoopStage,
};

export function getStageHandler(stageName: PipelineStage): StageHandler {
  const handler = registry[stageName];
  if (!handler) {
    throw new Error(`Stage "${stageName}" ainda não implementado nesta fase.`);
  }
  return handler;
}
