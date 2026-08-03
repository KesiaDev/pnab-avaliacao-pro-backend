import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger } from "../src/observability/logger.js";
import type { MatchedChunk } from "../src/integrations/internal-api.js";

vi.mock("../src/integrations/openai.js", () => ({
  createOpenAIClient: vi.fn(() => ({ fake: "client" })),
  embedTexts: vi.fn(async () => [[0.1, 0.2]]),
  completeJSON: vi.fn(),
  estimateCostUsd: vi.fn(() => 0.001),
}));
vi.mock("../src/shared/env.js", () => ({
  loadEnv: vi.fn(() => ({
    OPENAI_API_KEY: "sk-test",
    OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
    OPENAI_MODEL_EXTRACTION: "gpt-5.4-nano",
  })),
}));

const openai = await import("../src/integrations/openai.js");
const { runAuditoriaOrcamentariaStage } = await import("../src/worker/stages/auditoriaOrcamentaria.js");

function makeChunks(): MatchedChunk[] {
  return [
    { chunkId: "c1", fileId: "file-1", fileNome: "Planilha Orçamentária.pdf", paginaInicial: 1, paginaFinal: 1, texto: "planilha", similarity: 0.9 },
  ];
}

function mockBudget(budget: Record<string, unknown>) {
  vi.mocked(openai.completeJSON).mockResolvedValue({
    result: budget as never,
    usage: { inputTokens: 10, outputTokens: 10 },
  });
}

function baseInternalApi() {
  return {
    getCostStatus: vi.fn(async () => ({
      budgetTotal: 0,
      editalConsumed: 0,
      limitPerApplication: 0,
      applicationConsumed: 0,
      blockOnExceed: true,
    })),
    matchDocumentChunks: vi.fn(async () => ({ chunks: makeChunks() })),
    saveCostEntry: vi.fn(async () => ({ ok: true as const })),
    saveFlag: vi.fn(async () => ({ ok: true as const })),
    saveEvidence: vi.fn(async () => ({ ok: true as const, saved: 0 })),
  };
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

describe("runAuditoriaOrcamentariaStage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("bloqueia a etapa quando o orçamento do edital já foi excedido (ADR-10)", async () => {
    const matchDocumentChunks = vi.fn(async () => ({ chunks: makeChunks() }));
    const input = makeInput({
      matchDocumentChunks,
      getCostStatus: vi.fn(async () => ({
        budgetTotal: 10,
        editalConsumed: 10,
        limitPerApplication: 0,
        applicationConsumed: 0,
        blockOnExceed: true,
      })),
    });
    await expect(runAuditoriaOrcamentariaStage(input)).rejects.toThrow("Orçamento do edital excedido");
    expect(matchDocumentChunks).not.toHaveBeenCalled();
  });

  it("lança erro quando não há chunks indexados", async () => {
    const input = makeInput({ matchDocumentChunks: vi.fn(async () => ({ chunks: [] })) });
    await expect(runAuditoriaOrcamentariaStage(input)).rejects.toThrow("Nenhum trecho de documento indexado");
  });

  it("não gera flag quando valor unitário × quantidade bate com o valor total informado", async () => {
    mockBudget({
      itens: [
        { chunkIndex: 1, descricaoItem: "Contador", valorUnitario: 2500, quantidade: 1, valorTotalInformado: 2500, possivelmenteDesproporcional: false, motivoDesproporcao: null },
      ],
      valorTotalDoProjetoInformado: 2500,
      valorTotalDoProjetoChunkIndex: 1,
    });
    const input = makeInput();

    const result = await runAuditoriaOrcamentariaStage(input);

    expect(input.internalApi.saveFlag).not.toHaveBeenCalled();
    expect(input.internalApi.saveEvidence).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, details: { itens: 1, divergencias: 0 } });
  });

  it("sinaliza divergência aritmética mesmo quando o total geral do projeto bate (o proponente ajustou só a coluna de total)", async () => {
    mockBudget({
      itens: [
        { chunkIndex: 1, descricaoItem: "Historiador", valorUnitario: 10000, quantidade: 1, valorTotalInformado: 11000, possivelmenteDesproporcional: false, motivoDesproporcao: null },
        { chunkIndex: 1, descricaoItem: "Contador", valorUnitario: 2500, quantidade: 1, valorTotalInformado: 2500, possivelmenteDesproporcional: false, motivoDesproporcao: null },
      ],
      // total geral bate com os 70 mil declarados em outro lugar da proposta,
      // mas a linha "Historiador" está incoerente -- tem que ser sinalizada
      // de qualquer forma.
      valorTotalDoProjetoInformado: 13500,
      valorTotalDoProjetoChunkIndex: 1,
    });
    const input = makeInput();

    const result = await runAuditoriaOrcamentariaStage(input);

    expect(input.internalApi.saveFlag).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      flag: expect.objectContaining({
        tipo: "divergencia_documental",
        descricao: expect.stringContaining("Historiador"),
      }),
    });
    expect(input.internalApi.saveEvidence).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      evidences: expect.arrayContaining([
        expect.objectContaining({ criterion: "D", robustez: "alta" }),
      ]),
    });
    expect(result.details).toMatchObject({ divergencias: 1 });
  });

  it("sinaliza quando a soma dos itens não bate com o valor total do projeto declarado", async () => {
    mockBudget({
      itens: [
        { chunkIndex: 1, descricaoItem: "Item A", valorUnitario: 1000, quantidade: 1, valorTotalInformado: 1000, possivelmenteDesproporcional: false, motivoDesproporcao: null },
      ],
      valorTotalDoProjetoInformado: 5000,
      valorTotalDoProjetoChunkIndex: 1,
    });
    const input = makeInput();

    await runAuditoriaOrcamentariaStage(input);

    expect(input.internalApi.saveFlag).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      flag: expect.objectContaining({
        tipo: "divergencia_documental",
        descricao: expect.stringContaining("Valor total do projeto"),
      }),
    });
  });

  it("sinaliza item possivelmente desproporcional como flag tipo outro, sem afirmar preço de mercado", async () => {
    mockBudget({
      itens: [
        {
          chunkIndex: 1,
          descricaoItem: "Designer",
          valorUnitario: 10000,
          quantidade: 1,
          valorTotalInformado: 10000,
          possivelmenteDesproporcional: true,
          motivoDesproporcao: "valor muito acima de itens de escopo semelhante no mesmo orçamento",
        },
      ],
      valorTotalDoProjetoInformado: 10000,
      valorTotalDoProjetoChunkIndex: 1,
    });
    const input = makeInput();

    await runAuditoriaOrcamentariaStage(input);

    expect(input.internalApi.saveFlag).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      flag: expect.objectContaining({ tipo: "outro", descricao: expect.stringContaining("Designer") }),
    });
  });

  it("não falha a etapa quando salvar uma flag dá erro (best-effort)", async () => {
    mockBudget({
      itens: [
        { chunkIndex: 1, descricaoItem: "X", valorUnitario: 100, quantidade: 1, valorTotalInformado: 999, possivelmenteDesproporcional: false, motivoDesproporcao: null },
      ],
      valorTotalDoProjetoInformado: null,
      valorTotalDoProjetoChunkIndex: null,
    });
    const input = makeInput({
      saveFlag: vi.fn(async () => {
        throw new Error("falha de rede");
      }),
    });

    await expect(runAuditoriaOrcamentariaStage(input)).resolves.toMatchObject({ ok: true });
  });
});
