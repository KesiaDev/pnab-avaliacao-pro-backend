import type { PipelineStage } from "../shared/queueNames.js";
import { runInventarioStage, type StageInput, type StageOutput } from "./stages/inventario.js";

type StageHandler = (input: StageInput) => Promise<StageOutput>;

// Só "inventario" está implementado nesta fase. Os demais nomes já existem
// no contrato (PIPELINE_STAGES, igual ao PROCESSING_STAGES do app web) pra
// Fase 5/6 não precisar renomear nada -- até lá, chamar um deles é erro de
// programação, não um caso a tratar silenciosamente.
const registry: Partial<Record<PipelineStage, StageHandler>> = {
  inventario: runInventarioStage,
};

export function getStageHandler(stage: PipelineStage): StageHandler {
  const handler = registry[stage];
  if (!handler) {
    throw new Error(`Stage "${stage}" ainda não implementado nesta fase.`);
  }
  return handler;
}
