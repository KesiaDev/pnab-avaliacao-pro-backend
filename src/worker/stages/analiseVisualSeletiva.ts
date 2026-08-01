import type { StageInput, StageOutput } from "./types.js";
import { renderPdfPageToPng, withTempPdf } from "../../integrations/poppler.js";
import type { PageNeedingVision } from "../../integrations/internal-api.js";

// ADR-9: nunca renderiza o PDF inteiro em imagem, só as páginas que
// extracao_textual marcou como precisa_visao (texto vazio/pouco confiável).
// Agrupa por arquivo pra baixar cada PDF uma única vez, mesmo que várias
// páginas dele precisem de render.
export async function runAnaliseVisualSeletivaStage(input: StageInput): Promise<StageOutput> {
  const { pages } = await input.internalApi.listPagesNeedingVision(input.applicationId);

  if (pages.length === 0) {
    input.logger.info({}, "analise_visual_seletiva_no_pages");
    return { ok: true, details: { paginasRenderizadas: 0 } };
  }

  const { files } = await input.internalApi.listProponentFiles(input.applicationId);
  const fileById = new Map(files.map((f) => [f.fileId, f]));

  const pagesByFile = new Map<string, PageNeedingVision[]>();
  for (const page of pages) {
    const list = pagesByFile.get(page.fileId) ?? [];
    list.push(page);
    pagesByFile.set(page.fileId, list);
  }

  let paginasRenderizadas = 0;
  const avisos: string[] = [];

  for (const [fileId, filePages] of pagesByFile) {
    const file = fileById.get(fileId);
    if (!file) {
      avisos.push(`Arquivo ${fileId} não encontrado (removido?) -- ${filePages.length} página(s) pulada(s).`);
      continue;
    }

    try {
      const res = await fetch(file.downloadUrl);
      if (!res.ok) throw new Error(`falha ao baixar (HTTP ${res.status})`);
      const binary = Buffer.from(await res.arrayBuffer());

      await withTempPdf(binary, async (pdfPath) => {
        for (const page of filePages) {
          try {
            const imageBuffer = await renderPdfPageToPng(pdfPath, page.numeroPagina);
            await input.internalApi.saveDocumentPageImage({
              pageId: page.pageId,
              imageBase64: imageBuffer.toString("base64"),
              mimeType: "image/png",
            });
            paginasRenderizadas += 1;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            avisos.push(`${file.nome} pág ${page.numeroPagina}: ${message}`);
          }
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      avisos.push(`${file.nome}: ${message}`);
    }
  }

  if (avisos.length > 0) {
    input.logger.warn({ avisos }, "analise_visual_seletiva_avisos");
  }
  // Mesma lógica de tolerância das etapas anteriores: só falha a etapa se
  // NENHUMA página foi renderizada -- uma página/arquivo pontualmente ruim
  // não deve travar o proponente inteiro.
  if (paginasRenderizadas === 0) {
    throw new Error(`Nenhuma página pôde ser renderizada: ${avisos.join(" | ")}`);
  }

  input.logger.info({ paginasRenderizadas }, "analise_visual_seletiva_completed");
  return { ok: true, details: { paginasRenderizadas, avisos } };
}
