export const APPLICATION_PROCESSING_QUEUE = "application-processing";
export const APPLICATION_PROCESSING_DLQ = "application-processing-dlq";

// Ordem completa do pipeline (Fase 6/7) — só "noop" está implementado nesta
// fase (2/3), o resto é o contrato já fixado para as próximas fases não
// precisarem renomear nada em voo.
export const PIPELINE_STAGES = [
  "noop",
  "inventory",
  "download",
  "extract_text",
  "analyze_visual_pages",
  "classify_documents",
  "chunk",
  "embed",
  "extract_project_structure",
  "extract_evidence_abc",
  "extract_evidence_defg",
  "calculate_bonus_h",
  "calculate_bonus_i",
  "calculate_bonus_j",
  "evaluate_abc",
  "evaluate_defg",
  "audit",
  "generate_opinion",
  "finalize_proposal",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];
