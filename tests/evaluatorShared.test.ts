import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger } from "../src/observability/logger.js";
import type { EditalCriterion, MatchedChunk } from "../src/integrations/internal-api.js";

vi.mock("../src/integrations/openai.js", () => ({
  createOpenAIClient: vi.fn(() => ({ fake: "client" })),
  embedTexts: vi.fn(async () => [[0.1, 0.2]]),
  completeJSON: vi.fn(),
  estimateCostUsd: vi.fn(() => 0.001),
}));
vi.mock("../src/shared/env.js", () => ({
  loadEnv: vi.fn(() => ({
    OPENAI_API_KEY: "sk-test",
    OPENAI_PROJECT_ID: undefined,
    OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
    OPENAI_MODEL_EVALUATION: "gpt-5.4-mini",
  })),
}));

const openai = await import("../src/integrations/openai.js");
const { runEvaluatorStage } = await import("../src/worker/stages/evaluatorShared.js");

function makeCriteria(): EditalCriterion[] {
  return [
    { code: "A", title: "Qualidade do projeto", description: "desc A", maximumScore: 20, eliminatory: true, bonus: false },
    { code: "B", title: "Relevância cultural local", description: "desc B", maximumScore: 20, eliminatory: true, bonus: false },
  ];
}

function makeChunks(): MatchedChunk[] {
  return [
    { chunkId: "chunk-1", fileId: "file-1", paginaInicial: 1, paginaFinal: 1, texto: "texto 1", similarity: 0.9 },
    { chunkId: "chunk-2", fileId: "file-2", paginaInicial: 2, paginaFinal: 2, texto: "texto 2", similarity: 0.8 },
  ];
}

function makeInput(overrides: Partial<ReturnType<typeof baseInternalApi>> = {}) {
  const internalApi = { ...baseInternalApi(), ...overrides };
  return {
    editalId: "edital-1",
    applicationId: "proponent-1",
    internalApi: internalApi as never,
    logger: createLogger({ NODE_ENV: "test" }),
  };
}

function baseInternalApi() {
  return {
    getEditalCriteria: vi.fn(async () => ({ criteria: makeCriteria() })),
    matchDocumentChunks: vi.fn(async () => ({ chunks: makeChunks() })),
    saveCostEntry: vi.fn(async () => ({ ok: true as const })),
    saveCriterionScores: vi.fn(async () => ({ ok: true as const, saved: 0 })),
    saveEvidence: vi.fn(async () => ({ ok: true as const, saved: 0 })),
  };
}

describe("runEvaluatorStage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lança erro quando nenhum critério é encontrado pro edital", async () => {
    const input = makeInput({ getEditalCriteria: vi.fn(async () => ({ criteria: [] })) });
    await expect(runEvaluatorStage(input, ["A", "B"], "avaliador_teste")).rejects.toThrow(
      "Nenhum dos critérios",
    );
  });

  it("lança erro quando não há chunks indexados", async () => {
    const input = makeInput({ matchDocumentChunks: vi.fn(async () => ({ chunks: [] })) });
    await expect(runEvaluatorStage(input, ["A", "B"], "avaliador_teste")).rejects.toThrow(
      "Nenhum trecho de documento indexado",
    );
  });

  it("grava nota e evidência pra cada critério, mapeando chunkIndex pro arquivo/página real", async () => {
    vi.mocked(openai.completeJSON).mockResolvedValue({
      result: {
        criteria: {
          A: { proposedScore: 18, justification: "boa proposta", humanReviewRequired: false, evidences: [{ chunkIndex: 1, descricaoFactual: "fato A", trechoRelevante: "trecho A", robustez: "alta" }] },
          B: { proposedScore: 15, justification: "relevante", humanReviewRequired: false, evidences: [] },
        },
      },
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    const input = makeInput();

    const result = await runEvaluatorStage(input, ["A", "B"], "avaliador_teste");

    expect(input.internalApi.saveCriterionScores).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      scores: [
        expect.objectContaining({ criterion: "A", proposedScore: 18, humanReviewRequired: false }),
        expect.objectContaining({ criterion: "B", proposedScore: 15, humanReviewRequired: false }),
      ],
    });
    expect(input.internalApi.saveEvidence).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      evidences: [
        expect.objectContaining({ criterion: "A", fileId: "file-1", paginaInicial: 1, descricaoFactual: "fato A" }),
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("clampa nota fora do teto e força revisão humana", async () => {
    vi.mocked(openai.completeJSON).mockResolvedValue({
      result: {
        criteria: {
          A: { proposedScore: 999, justification: "nota exagerada", humanReviewRequired: false, evidences: [] },
          B: { proposedScore: -5, justification: "nota negativa", humanReviewRequired: false, evidences: [] },
        },
      },
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const input = makeInput();

    await runEvaluatorStage(input, ["A", "B"], "avaliador_teste");

    expect(input.internalApi.saveCriterionScores).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      scores: [
        expect.objectContaining({ criterion: "A", proposedScore: 20, humanReviewRequired: true }),
        expect.objectContaining({ criterion: "B", proposedScore: 0, humanReviewRequired: true }),
      ],
    });
  });

  it("preenche nota 0 com revisão humana quando a IA não retorna um dos critérios pedidos", async () => {
    vi.mocked(openai.completeJSON).mockResolvedValue({
      result: { criteria: { A: { proposedScore: 10, justification: "ok", humanReviewRequired: false, evidences: [] } } },
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const input = makeInput();

    await runEvaluatorStage(input, ["A", "B"], "avaliador_teste");

    expect(input.internalApi.saveCriterionScores).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      scores: [
        expect.objectContaining({ criterion: "A", proposedScore: 10 }),
        expect.objectContaining({ criterion: "B", proposedScore: 0, humanReviewRequired: true }),
      ],
    });
  });

  it("não falha a etapa quando salvar o custo dá erro (best-effort)", async () => {
    vi.mocked(openai.completeJSON).mockResolvedValue({
      result: { criteria: { A: { proposedScore: 5, justification: "ok", humanReviewRequired: false, evidences: [] }, B: { proposedScore: 5, justification: "ok", humanReviewRequired: false, evidences: [] } } },
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const input = makeInput({ saveCostEntry: vi.fn(async () => { throw new Error("falha de rede"); }) });

    await expect(runEvaluatorStage(input, ["A", "B"], "avaliador_teste")).resolves.toMatchObject({ ok: true });
  });
});
