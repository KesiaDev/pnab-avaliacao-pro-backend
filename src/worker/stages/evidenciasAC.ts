import type { StageInput, StageOutput } from "./types.js";
import { runEvaluatorStage } from "./evaluatorShared.js";

// Critérios culturais (A-C): qualidade do projeto, relevância cultural
// local, integração comunitária. Ver evaluatorShared.ts pra lógica real
// (busca semântica + avaliação em uma chamada).
export async function runEvidenciasACStage(input: StageInput): Promise<StageOutput> {
  return runEvaluatorStage(input, ["A", "B", "C"], "avaliador_cultural_abc");
}
