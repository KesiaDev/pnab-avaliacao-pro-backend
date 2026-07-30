export interface PastStageAttempt {
  inputHash: string;
  status: "concluido" | "erro" | "em_andamento";
}

export type StageDecision =
  | { action: "skip"; reason: "already_completed_same_hash" }
  | { action: "run" };

// ADR-2: uma etapa concluída com o mesmo hash de entrada nunca é
// reprocessada. Hash diferente (entrada mudou) ou status diferente de
// "concluido" sempre roda de novo — falha anterior nunca "trava" a etapa.
export function decideStageExecution(
  pastAttempts: PastStageAttempt[],
  currentInputHash: string,
): StageDecision {
  const alreadyDone = pastAttempts.some(
    (attempt) => attempt.status === "concluido" && attempt.inputHash === currentInputHash,
  );
  return alreadyDone ? { action: "skip", reason: "already_completed_same_hash" } : { action: "run" };
}
