import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger } from "../src/observability/logger.js";
import type { ChunkNeedingEmbedding } from "../src/integrations/internal-api.js";

vi.mock("../src/integrations/openai.js", () => ({
  createOpenAIClient: vi.fn(() => ({ fake: "client" })),
  embedTextsWithUsage: vi.fn(),
  estimateCostUsd: vi.fn(() => 0.001),
}));
vi.mock("../src/shared/env.js", () => ({
  loadEnv: vi.fn(() => ({
    OPENAI_API_KEY: "sk-test",
    OPENAI_PROJECT_ID: undefined,
    OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
  })),
}));

const openai = await import("../src/integrations/openai.js");
const { runIndexacaoStage } = await import("../src/worker/stages/indexacao.js");

function baseInternalApi() {
  return {
    getCostStatus: vi.fn(async () => ({
      budgetTotal: 0,
      editalConsumed: 0,
      limitPerApplication: 0,
      applicationConsumed: 0,
      blockOnExceed: true,
    })),
    saveCostEntry: vi.fn(async () => ({ ok: true as const })),
    saveChunkEmbedding: vi.fn(async () => ({ ok: true as const })),
  };
}

function makeInput(
  chunks: ChunkNeedingEmbedding[],
  overrides: Partial<ReturnType<typeof baseInternalApi>> = {},
) {
  const internalApi = { ...baseInternalApi(), ...overrides };
  return {
    input: {
      editalId: "edital-1",
      applicationId: "proponent-1",
      internalApi: {
        listChunksNeedingEmbedding: vi.fn(async () => ({ chunks })),
        ...internalApi,
      } as never,
      logger: createLogger({ NODE_ENV: "test" }),
    },
    internalApi,
  };
}

describe("runIndexacaoStage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("não faz nada quando não há chunks pra indexar (e nem checa orçamento, pra não gastar uma chamada à toa)", async () => {
    const { input, internalApi } = makeInput([]);
    const result = await runIndexacaoStage(input);
    expect(result).toEqual({ ok: true, details: { chunksIndexados: 0 } });
    expect(openai.embedTextsWithUsage).not.toHaveBeenCalled();
    expect(internalApi.getCostStatus).not.toHaveBeenCalled();
  });

  it("embeda em lote, grava um embedding por chunk e registra o custo real (antes ficava totalmente de fora)", async () => {
    const chunks: ChunkNeedingEmbedding[] = [
      { chunkId: "chunk-1", texto: "primeiro chunk" },
      { chunkId: "chunk-2", texto: "segundo chunk" },
    ];
    vi.mocked(openai.embedTextsWithUsage).mockResolvedValue({
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      usage: { inputTokens: 42, outputTokens: 0 },
    });
    const { input, internalApi } = makeInput(chunks);

    const result = await runIndexacaoStage(input);

    expect(openai.embedTextsWithUsage).toHaveBeenCalledWith(
      { fake: "client" },
      "text-embedding-3-small",
      ["primeiro chunk", "segundo chunk"],
    );
    expect(internalApi.saveChunkEmbedding).toHaveBeenCalledWith({
      chunkId: "chunk-1",
      embedding: [0.1, 0.2],
      modelo: "text-embedding-3-small",
    });
    expect(internalApi.saveCostEntry).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "indexacao", inputTokens: 42, outputTokens: 0 }),
    );
    expect(result).toEqual({
      ok: true,
      details: { chunksIndexados: 2, avisos: [] },
    });
  });

  it("bloqueia a etapa quando o orçamento do edital já foi excedido", async () => {
    const chunks: ChunkNeedingEmbedding[] = [{ chunkId: "chunk-1", texto: "texto" }];
    const { input, internalApi } = makeInput(chunks, {
      getCostStatus: vi.fn(async () => ({
        budgetTotal: 10,
        editalConsumed: 15,
        limitPerApplication: 0,
        applicationConsumed: 0,
        blockOnExceed: true,
      })),
    });

    await expect(runIndexacaoStage(input)).rejects.toThrow("Orçamento do edital excedido");
    expect(openai.embedTextsWithUsage).not.toHaveBeenCalled();
    expect(internalApi.saveChunkEmbedding).not.toHaveBeenCalled();
  });

  it("lança erro quando nenhum chunk é indexado com sucesso", async () => {
    vi.mocked(openai.embedTextsWithUsage).mockRejectedValue(new Error("rate limit"));
    const chunks: ChunkNeedingEmbedding[] = [{ chunkId: "chunk-1", texto: "texto" }];
    const { input } = makeInput(chunks);
    await expect(runIndexacaoStage(input)).rejects.toThrow("Nenhum chunk pôde ser indexado");
  });

  it("não falha o proponente inteiro quando só um chunk falha ao gravar", async () => {
    vi.mocked(openai.embedTextsWithUsage).mockResolvedValue({
      embeddings: [[0.1], [0.2]],
      usage: { inputTokens: 10, outputTokens: 0 },
    });
    const saveChunkEmbedding = vi
      .fn()
      .mockRejectedValueOnce(new Error("falha de rede"))
      .mockResolvedValueOnce({ ok: true as const });
    const chunks: ChunkNeedingEmbedding[] = [
      { chunkId: "chunk-ruim", texto: "a" },
      { chunkId: "chunk-bom", texto: "b" },
    ];
    const { input } = makeInput(chunks, { saveChunkEmbedding });
    const result = await runIndexacaoStage(input);
    expect(result.details).toMatchObject({ chunksIndexados: 1 });
    expect((result.details?.avisos as string[])[0]).toContain("chunk-ruim");
  });

  it("não falha a etapa quando salvar o custo dá erro (best-effort)", async () => {
    vi.mocked(openai.embedTextsWithUsage).mockResolvedValue({
      embeddings: [[0.1]],
      usage: { inputTokens: 10, outputTokens: 0 },
    });
    const chunks: ChunkNeedingEmbedding[] = [{ chunkId: "chunk-1", texto: "texto" }];
    const { input } = makeInput(chunks, {
      saveCostEntry: vi.fn(async () => {
        throw new Error("falha de rede");
      }),
    });

    await expect(runIndexacaoStage(input)).resolves.toMatchObject({ ok: true });
  });
});
