import { describe, it, expect, vi } from "vitest";
import { runFragmentacaoStage } from "../src/worker/stages/fragmentacao.js";
import { createLogger } from "../src/observability/logger.js";
import type { DocumentPageForChunking } from "../src/integrations/internal-api.js";

function makeInput(pages: DocumentPageForChunking[], saveDocumentChunks = vi.fn(async () => ({ ok: true as const, saved: 0 }))) {
  return {
    editalId: "edital-1",
    applicationId: "proponent-1",
    internalApi: {
      listDocumentPages: vi.fn(async () => ({ pages })),
      saveDocumentChunks,
    } as never,
    logger: createLogger({ NODE_ENV: "test" }),
  };
}

describe("runFragmentacaoStage", () => {
  it("não faz nada quando o proponente não tem páginas extraídas", async () => {
    const result = await runFragmentacaoStage(makeInput([]));
    expect(result).toEqual({ ok: true, details: { chunksGerados: 0 } });
  });

  it("agrupa páginas por arquivo e grava os chunks de cada um separadamente", async () => {
    const saveDocumentChunks = vi.fn(async () => ({ ok: true as const, saved: 0 }));
    const pages: DocumentPageForChunking[] = [
      { fileId: "file-1", fileVersionId: "v1", numeroPagina: 2, texto: "segunda página" },
      { fileId: "file-1", fileVersionId: "v1", numeroPagina: 1, texto: "primeira página" },
      { fileId: "file-2", fileVersionId: "v2", numeroPagina: 1, texto: "outro arquivo" },
    ];
    const result = await runFragmentacaoStage(makeInput(pages, saveDocumentChunks));

    expect(saveDocumentChunks).toHaveBeenCalledTimes(2);
    // Confirma que a página 1 vem antes da 2 mesmo tendo chegado fora de ordem.
    const file1Call = saveDocumentChunks.mock.calls.find((c) => c[0].fileId === "file-1");
    expect(file1Call?.[0].chunks[0].texto).toBe("primeira página segunda página");
    expect(result.ok).toBe(true);
    expect(result.details).toMatchObject({ chunksGerados: 2 });
  });

  it("um arquivo com erro ao salvar não impede os demais de serem gravados", async () => {
    const saveDocumentChunks = vi
      .fn()
      .mockRejectedValueOnce(new Error("falha de rede"))
      .mockResolvedValueOnce({ ok: true as const, saved: 1 });
    const pages: DocumentPageForChunking[] = [
      { fileId: "file-ruim", fileVersionId: "v1", numeroPagina: 1, texto: "texto" },
      { fileId: "file-bom", fileVersionId: "v2", numeroPagina: 1, texto: "texto" },
    ];
    const result = await runFragmentacaoStage(makeInput(pages, saveDocumentChunks));
    expect(result.ok).toBe(true);
    expect(result.details).toMatchObject({ chunksGerados: 1 });
    expect((result.details?.avisos as string[])[0]).toContain("falha de rede");
  });
});
