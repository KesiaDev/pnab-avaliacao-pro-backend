import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger } from "../src/observability/logger.js";
import type { ChunkNeedingEmbedding } from "../src/integrations/internal-api.js";

vi.mock("../src/integrations/openai.js", () => ({
  createOpenAIClient: vi.fn(() => ({ fake: "client" })),
  embedTexts: vi.fn(),
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

function makeInput(
  chunks: ChunkNeedingEmbedding[],
  saveChunkEmbedding = vi.fn(async () => ({ ok: true as const })),
) {
  return {
    editalId: "edital-1",
    applicationId: "proponent-1",
    internalApi: {
      listChunksNeedingEmbedding: vi.fn(async () => ({ chunks })),
      saveChunkEmbedding,
    } as never,
    logger: createLogger({ NODE_ENV: "test" }),
  };
}

describe("runIndexacaoStage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("não faz nada quando não há chunks pra indexar", async () => {
    const result = await runIndexacaoStage(makeInput([]));
    expect(result).toEqual({ ok: true, details: { chunksIndexados: 0 } });
    expect(openai.embedTexts).not.toHaveBeenCalled();
  });

  it("embeda em lote e grava um embedding por chunk", async () => {
    const chunks: ChunkNeedingEmbedding[] = [
      { chunkId: "chunk-1", texto: "primeiro chunk" },
      { chunkId: "chunk-2", texto: "segundo chunk" },
    ];
    vi.mocked(openai.embedTexts).mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const saveChunkEmbedding = vi.fn(async () => ({ ok: true as const }));
    const input = makeInput(chunks, saveChunkEmbedding);

    const result = await runIndexacaoStage(input);

    expect(openai.embedTexts).toHaveBeenCalledWith(
      { fake: "client" },
      "text-embedding-3-small",
      ["primeiro chunk", "segundo chunk"],
    );
    expect(saveChunkEmbedding).toHaveBeenCalledWith({
      chunkId: "chunk-1",
      embedding: [0.1, 0.2],
      modelo: "text-embedding-3-small",
    });
    expect(result).toEqual({
      ok: true,
      details: { chunksIndexados: 2, avisos: [] },
    });
  });

  it("lança erro quando nenhum chunk é indexado com sucesso", async () => {
    vi.mocked(openai.embedTexts).mockRejectedValue(new Error("rate limit"));
    const chunks: ChunkNeedingEmbedding[] = [{ chunkId: "chunk-1", texto: "texto" }];
    await expect(runIndexacaoStage(makeInput(chunks))).rejects.toThrow(
      "Nenhum chunk pôde ser indexado",
    );
  });

  it("não falha o proponente inteiro quando só um chunk falha ao gravar", async () => {
    vi.mocked(openai.embedTexts).mockResolvedValue([[0.1], [0.2]]);
    const saveChunkEmbedding = vi
      .fn()
      .mockRejectedValueOnce(new Error("falha de rede"))
      .mockResolvedValueOnce({ ok: true as const });
    const chunks: ChunkNeedingEmbedding[] = [
      { chunkId: "chunk-ruim", texto: "a" },
      { chunkId: "chunk-bom", texto: "b" },
    ];
    const result = await runIndexacaoStage(makeInput(chunks, saveChunkEmbedding));
    expect(result.details).toMatchObject({ chunksIndexados: 1 });
    expect((result.details?.avisos as string[])[0]).toContain("chunk-ruim");
  });
});
