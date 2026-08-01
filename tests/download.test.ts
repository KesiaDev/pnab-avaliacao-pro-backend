import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runDownloadStage } from "../src/worker/stages/download.js";
import { createLogger } from "../src/observability/logger.js";
import type { ProponentFile } from "../src/integrations/internal-api.js";

function makeFile(overrides: Partial<ProponentFile> = {}): ProponentFile {
  return {
    fileId: "file-1",
    fileVersionId: "version-1",
    nome: "arquivo.pdf",
    mimeType: "application/pdf",
    tipoDocumental: "outro",
    downloadUrl: "https://storage.test/arquivo.pdf",
    ...overrides,
  };
}

function makeInput(files: ProponentFile[]) {
  return {
    editalId: "edital-1",
    applicationId: "proponent-1",
    internalApi: {
      listProponentFiles: vi.fn(async () => ({ files })),
    } as never,
    logger: createLogger({ NODE_ENV: "test" }),
  };
}

describe("runDownloadStage", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("lança erro quando o proponente não tem nenhum arquivo", async () => {
    const input = makeInput([]);
    await expect(runDownloadStage(input)).rejects.toThrow(
      "não tem nenhum arquivo importado do Drive",
    );
  });

  it("confirma sucesso quando todas as URLs assinadas respondem", async () => {
    const files = [makeFile(), makeFile({ fileId: "file-2", nome: "outro.pdf" })];
    global.fetch = vi.fn(async () => new Response(null, { status: 200 })) as never;
    const result = await runDownloadStage(makeInput(files));
    expect(result).toEqual({ ok: true, details: { totalArquivos: 2 } });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("lança erro listando os arquivos que falharam no HEAD", async () => {
    const files = [makeFile({ nome: "bom.pdf" }), makeFile({ fileId: "file-2", nome: "ruim.pdf" })];
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      return new Response(null, { status: call === 1 ? 200 : 404 });
    }) as never;
    await expect(runDownloadStage(makeInput(files))).rejects.toThrow("ruim.pdf (HTTP 404)");
  });
});
