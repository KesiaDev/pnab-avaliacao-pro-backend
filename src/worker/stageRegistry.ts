import type { PipelineStage } from "../shared/queueNames.js";
import type { StageInput, StageOutput } from "./stages/types.js";
import { runInventarioStage } from "./stages/inventario.js";
import { runDownloadStage } from "./stages/download.js";
import { runExtracaoTextualStage } from "./stages/extracaoTextual.js";

type StageHandler = (input: StageInput) => Promise<StageOutput>;

// Os demais nomes (analise_visual_seletiva, fragmentacao, indexacao,
// evidencias_a_c, evidencias_d_g, bonus_h_j, auditoria, parecer) já existem
// no contrato (PIPELINE_STAGES, igual ao PROCESSING_STAGES do app web) pra
// Fase 6/7 não precisar renomear nada -- até lá, chamar um deles é erro de
// programação, não um caso a tratar silenciosamente.
const registry: Partial<Record<PipelineStage, StageHandler>> = {
  inventario: runInventarioStage,
  download: runDownloadStage,
  extracao_textual: runExtracaoTextualStage,
};

export function getStageHandler(stage: PipelineStage): StageHandler {
  const handler = registry[stage];
  if (!handler) {
    throw new Error(`Stage "${stage}" ainda não implementado nesta fase.`);
  }
  return handler;
}
