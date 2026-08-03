import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger } from "../src/observability/logger.js";

vi.mock("../src/integrations/openai.js", () => ({
  createOpenAIClient: vi.fn(() => ({ fake: "client" })),
  completeJSON: vi.fn(),
  estimateCostUsd: vi.fn(() => 0.002),
}));
vi.mock("../src/shared/env.js", () => ({
  loadEnv: vi.fn(() => ({
    OPENAI_API_KEY: "sk-test",
    OPENAI_MODEL_AUDIT: "gpt-5.4-mini",
  })),
}));

const openai = await import("../src/integrations/openai.js");
const { runParecerStage } = await import("../src/worker/stages/parecer.js");

function makeInput(overrides: Record<string, unknown> = {}) {
  const saveParecer = vi.fn(async () => ({ ok: true as const, versao: 1 }));
  const internalApi = {
    getCostStatus: vi.fn(async () => ({
      budgetTotal: 0,
      editalConsumed: 0,
      limitPerApplication: 0,
      applicationConsumed: 0,
      blockOnExceed: true,
    })),
    getEvaluationContext: vi.fn(async () => ({
      proponentNome: "Proponente Teste",
      criterionScores: [
        { criterion: "A", maxScore: 20, proposedScore: 18, approvedScore: null, appliedBand: null, justification: "boa proposta" },
      ],
      evidenceCountByCriterion: { A: 2 },
      mandatorySubtotal: 18,
      bonusSubtotal: 0,
      individualTotal: 18,
      zeroInMandatoryCriterion: false,
    })),
    getEditalCriteria: vi.fn(async () => ({
      criteria: [
        { code: "A", title: "Qualidade do projeto", description: "desc", maximumScore: 20, eliminatory: true, bonus: false },
      ],
    })),
    saveCostEntry: vi.fn(async () => ({ ok: true as const })),
    saveParecer,
    ...overrides,
  };
  return {
    input: {
      editalId: "edital-1",
      applicationId: "proponent-1",
      internalApi: internalApi as never,
      logger: createLogger({ NODE_ENV: "test" }),
    },
    saveParecer,
  };
}

describe("runParecerStage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("bloqueia a etapa quando o orçamento do edital já foi excedido (ADR-10)", async () => {
    const { input, saveParecer } = makeInput({
      getCostStatus: vi.fn(async () => ({
        budgetTotal: 10,
        editalConsumed: 10,
        limitPerApplication: 0,
        applicationConsumed: 0,
        blockOnExceed: true,
      })),
    });
    await expect(runParecerStage(input)).rejects.toThrow("Orçamento do edital excedido");
    expect(saveParecer).not.toHaveBeenCalled();
  });

  it("grava o texto do parecer retornado pela IA", async () => {
    vi.mocked(openai.completeJSON).mockResolvedValue({
      result: { parecer: "A avaliação foi realizada com base exclusivamente..." },
      usage: { inputTokens: 200, outputTokens: 300 },
    });
    const { input, saveParecer } = makeInput();

    const result = await runParecerStage(input);

    expect(saveParecer).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      texto: "A avaliação foi realizada com base exclusivamente...",
    });
    expect(result).toEqual({ ok: true, details: { versao: 1 } });
  });

  it("usa a nota aprovada pela avaliadora no resumo enviado à IA, não a nota proposta pelo agente (regressão: correção manual nunca aparecia na minuta)", async () => {
    vi.mocked(openai.completeJSON).mockResolvedValue({
      result: { parecer: "texto qualquer" },
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const { input } = makeInput({
      getEvaluationContext: vi.fn(async () => ({
        proponentNome: "Proponente Teste",
        criterionScores: [
          {
            criterion: "J",
            maxScore: 10,
            proposedScore: 10,
            approvedScore: 0,
            appliedBand: null,
            justification: "corrigido manualmente pela avaliadora",
          },
        ],
        evidenceCountByCriterion: { J: 0 },
        mandatorySubtotal: 0,
        bonusSubtotal: 0,
        individualTotal: 0,
        zeroInMandatoryCriterion: false,
      })),
    });

    await runParecerStage(input);

    const userPrompt = vi.mocked(openai.completeJSON).mock.calls[0]?.[3] as string;
    const resumo = JSON.parse(userPrompt.split("RESUMO DA AVALIAÇÃO (JSON):\n\n")[1] as string);
    expect(resumo.criterios[0].notaAtribuida).toBe(0);
  });

  it("lança erro e nunca salva quando o parecer contém caracteres de outro alfabeto (defeito estocástico do modelo)", async () => {
    vi.mocked(openai.completeJSON).mockResolvedValue({
      result: { parecer: "Atribuí 18 pontos... contribuíram para sua गठनação." },
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const { input, saveParecer } = makeInput();

    await expect(runParecerStage(input)).rejects.toThrow("caracteres inesperados");
    expect(saveParecer).not.toHaveBeenCalled();
  });

  it("lança erro quando a IA devolve parecer vazio", async () => {
    vi.mocked(openai.completeJSON).mockResolvedValue({
      result: { parecer: "" },
      usage: { inputTokens: 10, outputTokens: 0 },
    });
    const { input, saveParecer } = makeInput();

    await expect(runParecerStage(input)).rejects.toThrow("não retornou texto de parecer");
    expect(saveParecer).not.toHaveBeenCalled();
  });
});
