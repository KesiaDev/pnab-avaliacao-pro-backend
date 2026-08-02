import type { StageInput, StageOutput } from "./types.js";
import { runEvaluatorStage } from "./evaluatorShared.js";

// Critérios técnicos (D-G): orçamento e cronograma, plano de divulgação,
// ficha técnica, trajetória. Ver evaluatorShared.ts pra lógica real (busca
// semântica + avaliação em uma chamada).
export async function runEvidenciasDGStage(input: StageInput): Promise<StageOutput> {
  return runEvaluatorStage(input, ["D", "E", "F", "G"], "avaliador_tecnico_defg");
}
