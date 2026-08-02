import type { StageInput, StageOutput } from "./types.js";

const AGENT_NAME = "auditor";
const MANDATORY_CODES = ["A", "B", "C", "D", "E", "F", "G"];

// 100% determinístico (ADR-8): confere que toda nota proposta > 0 tem pelo
// menos uma evidência vinculada -- nunca usa IA, só soma o que já foi
// gravado pelas etapas anteriores. Uma nota sem evidência não é corrigida
// automaticamente aqui, só sinalizada com uma flag pra revisão humana.
export async function runAuditoriaStage(input: StageInput): Promise<StageOutput> {
  const context = await input.internalApi.getEvaluationContext(input.applicationId);

  const semEvidencia = context.criterionScores.filter(
    (cs) => (cs.proposedScore ?? 0) > 0 && (context.evidenceCountByCriterion[cs.criterion] ?? 0) === 0,
  );

  for (const cs of semEvidencia) {
    await input.internalApi
      .saveFlag({
        proponentId: input.applicationId,
        flag: {
          tipo: "outro",
          descricao: `Critério ${cs.criterion} recebeu nota ${cs.proposedScore} sem nenhuma evidência vinculada -- requer verificação humana antes da aprovação.`,
          criadoPorAgente: AGENT_NAME,
        },
      })
      .catch((err) => input.logger.warn({ err }, "save_flag_failed"));
  }

  const zeroInMandatory = context.criterionScores.some(
    (cs) => MANDATORY_CODES.includes(cs.criterion) && (cs.proposedScore ?? 0) === 0,
  );

  input.logger.info(
    {
      semEvidencia: semEvidencia.map((cs) => cs.criterion),
      zeroInMandatory,
      individualTotal: context.individualTotal,
    },
    "auditoria_completed",
  );

  return {
    ok: true,
    details: {
      semEvidencia: semEvidencia.length,
      zeroInMandatory,
      individualTotal: context.individualTotal,
    },
  };
}
