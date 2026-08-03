import type { PipelineStage } from "../shared/queueNames.js";
import type { StageInput, StageOutput } from "./stages/types.js";
import { runInventarioStage } from "./stages/inventario.js";
import { runDownloadStage } from "./stages/download.js";
import { runExtracaoTextualStage } from "./stages/extracaoTextual.js";
import { runAnaliseVisualSeletivaStage } from "./stages/analiseVisualSeletiva.js";
import { runFragmentacaoStage } from "./stages/fragmentacao.js";
import { runIndexacaoStage } from "./stages/indexacao.js";
import { runEvidenciasACStage } from "./stages/evidenciasAC.js";
import { runEvidenciasDGStage } from "./stages/evidenciasDG.js";
import { runAuditoriaOrcamentariaStage } from "./stages/auditoriaOrcamentaria.js";
import { runBonusHJStage } from "./stages/bonusHJ.js";
import { runAuditoriaStage } from "./stages/auditoria.js";
import { runParecerStage } from "./stages/parecer.js";

type StageHandler = (input: StageInput) => Promise<StageOutput>;

// Todas as etapas do pipeline (PIPELINE_STAGES, igual ao PROCESSING_STAGES
// do app web) estão implementadas -- ver Fase 6 (inventario..indexacao) e
// Fase 7 (evidencias_a_c..parecer).
const registry: Partial<Record<PipelineStage, StageHandler>> = {
  inventario: runInventarioStage,
  download: runDownloadStage,
  extracao_textual: runExtracaoTextualStage,
  analise_visual_seletiva: runAnaliseVisualSeletivaStage,
  fragmentacao: runFragmentacaoStage,
  indexacao: runIndexacaoStage,
  evidencias_a_c: runEvidenciasACStage,
  evidencias_d_g: runEvidenciasDGStage,
  auditoria_orcamentaria: runAuditoriaOrcamentariaStage,
  bonus_h_j: runBonusHJStage,
  auditoria: runAuditoriaStage,
  parecer: runParecerStage,
};

export function getStageHandler(stage: PipelineStage): StageHandler {
  const handler = registry[stage];
  if (!handler) {
    throw new Error(`Stage "${stage}" ainda não implementado nesta fase.`);
  }
  return handler;
}
