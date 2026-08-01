import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger } from "../src/observability/logger.js";
import type { ProponentFile } from "../src/integrations/internal-api.js";

vi.mock("../src/integrations/poppler.js", () => ({
  getPdfPageCount: vi.fn(),
  extractPdfPagesText: vi.fn(),
  withTempPdf: vi.fn(async (_binary: Buffer, fn: (path: string) => Promise<unknown>) =>
    fn("/tmp/fake.pdf"),
  ),
}));

const poppler = await import("../src/integrations/poppler.js");
const { runExtracaoTextualStage } = await import("../src/worker/stages/extracaoTextual.js");

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

function makeInput(files: ProponentFile[], saveDocumentPages = vi.fn(async () => ({ ok: true as const, saved: 0 }))) {
  return {
    editalId: "edital-1",
    applicationId: "proponent-1",
    internalApi: {
      listProponentFiles: vi.fn(async () => ({ files })),
      saveDocumentPages,
    } as never,
    logger: createLogger({ NODE_ENV: "test" }),
  };
}

describe("runExtracaoTextualStage", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("pula proponente sem PDFs sem chamar Poppler", async () => {
    const input = makeInput([makeFile({ mimeType: "image/jpeg" })]);
    const result = await runExtracaoTextualStage(input);
    expect(result).toEqual({ ok: true, details: { arquivosProcessados: 0 } });
    expect(poppler.getPdfPageCount).not.toHaveBeenCalled();
  });

  it("extrai texto por página, classifica qualidade e grava via internalApi", async () => {
    global.fetch = vi.fn(async () => new Response(new ArrayBuffer(10), { status: 200 })) as never;
    vi.mocked(poppler.getPdfPageCount).mockResolvedValue(2);
    vi.mocked(poppler.extractPdfPagesText).mockResolvedValue([
      "Texto normal de uma página com bastante conteúdo legível em português.",
      "", // página sem texto -> imagem_pura
    ]);
    const saveDocumentPages = vi.fn(async () => ({ ok: true as const, saved: 2 }));
    const input = makeInput([makeFile()], saveDocumentPages);

    const result = await runExtracaoTextualStage(input);

    expect(saveDocumentPages).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: "file-1",
        fileVersionId: "version-1",
        pages: [
          expect.objectContaining({ numeroPagina: 1, qualidade: "boa", precisaVisao: false }),
          expect.objectContaining({
            numeroPagina: 2,
            qualidade: "imagem_pura",
            precisaVisao: true,
            textLength: 0,
          }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.details).toMatchObject({ totalPaginas: 2, arquivosProcessados: 1 });
  });

  it("registra aviso e não falha quando pdfinfo e pdftotext divergem na contagem", async () => {
    global.fetch = vi.fn(async () => new Response(new ArrayBuffer(10), { status: 200 })) as never;
    vi.mocked(poppler.getPdfPageCount).mockResolvedValue(3);
    vi.mocked(poppler.extractPdfPagesText).mockResolvedValue(["só uma página extraída"]);
    const input = makeInput([makeFile()]);

    const result = await runExtracaoTextualStage(input);
    expect(result.ok).toBe(true);
    expect((result.details?.avisos as string[])[0]).toContain("pdfinfo indicou 3");
  });

  it("lança erro quando NENHUM pdf é processado com sucesso", async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 500 })) as never;
    const input = makeInput([makeFile()]);
    await expect(runExtracaoTextualStage(input)).rejects.toThrow("Nenhum PDF pôde ser processado");
  });

  it("não falha o proponente inteiro quando só um arquivo entre vários dá erro", async () => {
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response(null, { status: 500 })
        : new Response(new ArrayBuffer(10), { status: 200 });
    }) as never;
    vi.mocked(poppler.getPdfPageCount).mockResolvedValue(1);
    vi.mocked(poppler.extractPdfPagesText).mockResolvedValue(["texto ok"]);
    const input = makeInput([
      makeFile({ fileId: "file-ruim", nome: "ruim.pdf" }),
      makeFile({ fileId: "file-bom", nome: "bom.pdf" }),
    ]);

    const result = await runExtracaoTextualStage(input);
    expect(result.ok).toBe(true);
    expect(result.details).toMatchObject({ arquivosProcessados: 1 });
    expect((result.details?.avisos as string[])[0]).toContain("ruim.pdf");
  });
});
