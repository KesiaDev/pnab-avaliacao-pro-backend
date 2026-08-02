import { describe, it, expect, vi } from "vitest";
import { runAuditoriaStage } from "../src/worker/stages/auditoria.js";
import { createLogger } from "../src/observability/logger.js";

function makeInput(context: {
  proponentNome?: string;
  criterionScores: { criterion: string; maxScore: number; proposedScore: number | null; approvedScore: number | null; appliedBand: string | null; justification: string | null }[];
  evidenceCountByCriterion: Record<string, number>;
  mandatorySubtotal?: number;
  bonusSubtotal?: number;
  individualTotal: number;
  zeroInMandatoryCriterion?: boolean;
}) {
  const saveFlag = vi.fn(async () => ({ ok: true as const }));
  return {
    input: {
      editalId: "edital-1",
      applicationId: "proponent-1",
      internalApi: {
        getEvaluationContext: vi.fn(async () => ({
          proponentNome: "Proponente Teste",
          mandatorySubtotal: 0,
          bonusSubtotal: 0,
          zeroInMandatoryCriterion: false,
          ...context,
        })),
        saveFlag,
      } as never,
      logger: createLogger({ NODE_ENV: "test" }),
    },
    saveFlag,
  };
}

describe("runAuditoriaStage", () => {
  it("não cria flag quando toda nota > 0 tem evidência", async () => {
    const { input, saveFlag } = makeInput({
      criterionScores: [
        { criterion: "A", maxScore: 20, proposedScore: 15, approvedScore: null, appliedBand: null, justification: null },
      ],
      evidenceCountByCriterion: { A: 2 },
      individualTotal: 15,
    });

    const result = await runAuditoriaStage(input);

    expect(saveFlag).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ semEvidencia: 0, zeroInMandatory: false });
  });

  it("cria flag quando um critério tem nota > 0 sem evidência vinculada", async () => {
    const { input, saveFlag } = makeInput({
      criterionScores: [
        { criterion: "B", maxScore: 20, proposedScore: 10, approvedScore: null, appliedBand: null, justification: null },
      ],
      evidenceCountByCriterion: {},
      individualTotal: 10,
    });

    const result = await runAuditoriaStage(input);

    expect(saveFlag).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      flag: expect.objectContaining({ tipo: "outro", descricao: expect.stringContaining("B") }),
    });
    expect(result.details).toMatchObject({ semEvidencia: 1 });
  });

  it("nunca sinaliza falta de evidência quando a nota é 0 (nada a comprovar)", async () => {
    const { input, saveFlag } = makeInput({
      criterionScores: [
        { criterion: "C", maxScore: 20, proposedScore: 0, approvedScore: null, appliedBand: null, justification: null },
      ],
      evidenceCountByCriterion: {},
      individualTotal: 0,
    });

    await runAuditoriaStage(input);

    expect(saveFlag).not.toHaveBeenCalled();
  });

  it("detecta zero em critério obrigatório (A-G) mas ignora zero em bônus (H-J)", async () => {
    const { input: inputMandatory } = makeInput({
      criterionScores: [
        { criterion: "D", maxScore: 10, proposedScore: 0, approvedScore: null, appliedBand: null, justification: null },
      ],
      evidenceCountByCriterion: {},
      individualTotal: 0,
    });
    const resultMandatory = await runAuditoriaStage(inputMandatory);
    expect(resultMandatory.details).toMatchObject({ zeroInMandatory: true });

    const { input: inputBonus } = makeInput({
      criterionScores: [
        { criterion: "H", maxScore: 5, proposedScore: 0, approvedScore: null, appliedBand: null, justification: null },
      ],
      evidenceCountByCriterion: {},
      individualTotal: 0,
    });
    const resultBonus = await runAuditoriaStage(inputBonus);
    expect(resultBonus.details).toMatchObject({ zeroInMandatory: false });
  });
});
