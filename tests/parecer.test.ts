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
