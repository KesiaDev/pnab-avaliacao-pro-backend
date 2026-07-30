export const APPLICATION_PROCESSING_QUEUE = "application-processing";
export const APPLICATION_PROCESSING_DLQ = "application-processing-dlq";

// Mesma lista e mesma ordem de src/lib/api/types.ts (PROCESSING_STAGES) no
// repo web pnabavaliacaopro — nunca diverge, é o contrato real já em uso
// pelo frontend (job_stages.stage é texto livre no banco, mas o conjunto de
// valores válidos é este).
export const PIPELINE_STAGES = [
  "inventario",
  "download",
  "extracao_textual",
  "analise_visual_seletiva",
  "fragmentacao",
  "indexacao",
  "evidencias_a_c",
  "evidencias_d_g",
  "bonus_h_j",
  "auditoria",
  "parecer",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const STAGE_STATES = [
  "aguardando",
  "na_fila",
  "processando",
  "concluido",
  "falhou",
  "revisao",
  "cancelado",
] as const;

export type StageState = (typeof STAGE_STATES)[number];
