import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger } from "../src/observability/logger.js";
import type { PageNeedingVision, ProponentFile } from "../src/integrations/internal-api.js";

vi.mock("../src/integrations/poppler.js", () => ({
  renderPdfPageToPng: vi.fn(),
  withTempPdf: vi.fn(async (_binary: Buffer, fn: (path: string) => Promise<unknown>) =>
    fn("/tmp/fake.pdf"),
  ),
}));

const poppler = await import("../src/integrations/poppler.js");
const { runAnaliseVisualSeletivaStage } = await import(
  "../src/worker/stages/analiseVisualSeletiva.js"
);

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

function makeInput(pages: PageNeedingVision[], files: ProponentFile[]) {
  return {
    editalId: "edital-1",
    applicationId: "proponent-1",
    internalApi: {
      listPagesNeedingVision: vi.fn(async () => ({ pages })),
      listProponentFiles: vi.fn(async () => ({ files })),
      saveDocumentPageImage: vi.fn(async () => ({ ok: true as const })),
    } as never,
    logger: createLogger({ NODE_ENV: "test" }),
  };
}

describe("runAnaliseVisualSeletivaStage", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("não faz nada quando nenhuma página precisa de visão", async () => {
    const input = makeInput([], []);
    const result = await runAnaliseVisualSeletivaStage(input);
    expect(result).toEqual({ ok: true, details: { paginasRenderizadas: 0 } });
    expect(poppler.renderPdfPageToPng).not.toHaveBeenCalled();
  });

  it("renderiza cada página, baixando o PDF uma única vez por arquivo", async () => {
    global.fetch = vi.fn(async () => new Response(new ArrayBuffer(10), { status: 200 })) as never;
    vi.mocked(poppler.renderPdfPageToPng).mockResolvedValue(Buffer.from("fake-png"));
    const pages: PageNeedingVision[] = [
      { pageId: "page-1", fileId: "file-1", numeroPagina: 3 },
      { pageId: "page-2", fileId: "file-1", numeroPagina: 7 },
    ];
    const input = makeInput(pages, [makeFile()]);

    const result = await runAnaliseVisualSeletivaStage(input);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(poppler.renderPdfPageToPng).toHaveBeenCalledTimes(2);
    expect(input.internalApi.saveDocumentPageImage).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: "page-1", mimeType: "image/png" }),
    );
    expect(result).toEqual({
      ok: true,
      details: { paginasRenderizadas: 2, avisos: [] },
    });
  });

  it("lança erro quando nenhuma página é renderizada com sucesso", async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 404 })) as never;
    const pages: PageNeedingVision[] = [{ pageId: "page-1", fileId: "file-1", numeroPagina: 1 }];
    const input = makeInput(pages, [makeFile()]);

    await expect(runAnaliseVisualSeletivaStage(input)).rejects.toThrow(
      "Nenhuma página pôde ser renderizada",
    );
  });

  it("não falha o proponente inteiro quando só uma página entre várias dá erro", async () => {
    global.fetch = vi.fn(async () => new Response(new ArrayBuffer(10), { status: 200 })) as never;
    vi.mocked(poppler.renderPdfPageToPng)
      .mockRejectedValueOnce(new Error("página corrompida"))
      .mockResolvedValueOnce(Buffer.from("fake-png"));
    const pages: PageNeedingVision[] = [
      { pageId: "page-1", fileId: "file-1", numeroPagina: 1 },
      { pageId: "page-2", fileId: "file-1", numeroPagina: 2 },
    ];
    const input = makeInput(pages, [makeFile()]);

    const result = await runAnaliseVisualSeletivaStage(input);
    expect(result.details).toMatchObject({ paginasRenderizadas: 1 });
    expect((result.details?.avisos as string[])[0]).toContain("página corrompida");
  });
});
