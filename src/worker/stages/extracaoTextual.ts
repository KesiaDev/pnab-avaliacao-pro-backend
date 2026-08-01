import type { StageInput, StageOutput } from "./types.js";
import { getPdfPageCount, extractPdfPagesText, withTempPdf } from "../../integrations/poppler.js";
import type { DocumentPageInput, PageQuality } from "../../integrations/internal-api.js";

// ASCII imprimível (\x20-\x7E) + Latin-1 acentuado (À-ÿ, cobre
// À-ÿ) -- português sem falso-negativo em nome próprio/acento.
const PRINTABLE_RE = /[^\x20-\x7EÀ-ÿ]/g;

// Métrica de qualidade por página (ADR-9): decide se a página precisa de
// visão computacional (Fase seguinte, analise_visual_seletiva) em vez de só
// confiar no texto extraído -- página escaneada/imagem pura não tem texto
// nenhum; página com pouco texto ou muito ruído (OCR ruim, tabela quebrada)
// também não é confiável o bastante pra um agente ler sem apoio visual.
function computePageQuality(
  texto: string,
): Pick<DocumentPageInput, "textLength" | "printableRatio" | "qualidade" | "precisaVisao"> {
  const trimmed = texto.trim();
  const textLength = trimmed.length;
  if (textLength === 0) {
    return { textLength: 0, printableRatio: null, qualidade: "imagem_pura", precisaVisao: true };
  }
  const printable = trimmed.replace(PRINTABLE_RE, "").length;
  const printableRatio = printable / textLength;
  const qualidade: PageQuality = textLength < 40 || printableRatio < 0.6 ? "baixa" : "boa";
  return { textLength, printableRatio, qualidade, precisaVisao: qualidade !== "boa" };
}

export async function runExtracaoTextualStage(input: StageInput): Promise<StageOutput> {
  const { files } = await input.internalApi.listProponentFiles(input.applicationId);
  const pdfFiles = files.filter((f) => f.mimeType === "application/pdf");

  if (pdfFiles.length === 0) {
    input.logger.info({}, "extracao_textual_no_pdfs");
    return { ok: true, details: { arquivosProcessados: 0 } };
  }

  let totalPaginas = 0;
  let arquivosProcessados = 0;
  const avisos: string[] = [];

  for (const file of pdfFiles) {
    try {
      const res = await fetch(file.downloadUrl);
      if (!res.ok) throw new Error(`falha ao baixar (HTTP ${res.status})`);
      const binary = Buffer.from(await res.arrayBuffer());

      await withTempPdf(binary, async (pdfPath) => {
        const pageCount = await getPdfPageCount(pdfPath);
        const pagesText = await extractPdfPagesText(pdfPath);
        if (pagesText.length !== pageCount) {
          avisos.push(
            `${file.nome}: pdfinfo indicou ${pageCount} páginas, pdftotext extraiu ${pagesText.length}`,
          );
        }

        const pages: DocumentPageInput[] = pagesText.map((texto, idx) => ({
          numeroPagina: idx + 1,
          texto,
          ...computePageQuality(texto),
        }));

        await input.internalApi.saveDocumentPages({
          fileId: file.fileId,
          fileVersionId: file.fileVersionId,
          pages,
        });
        totalPaginas += pages.length;
      });
      arquivosProcessados += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      avisos.push(`${file.nome}: ${message}`);
    }
  }

  if (avisos.length > 0) {
    input.logger.warn({ avisos }, "extracao_textual_avisos");
  }
  // Um PDF pontualmente ruim (corrompido, protegido por senha) não deve
  // travar o proponente inteiro -- só falha a etapa se NENHUM arquivo saiu.
  if (arquivosProcessados === 0) {
    throw new Error(`Nenhum PDF pôde ser processado: ${avisos.join(" | ")}`);
  }

  input.logger.info({ totalPaginas, arquivosProcessados }, "extracao_textual_completed");
  return { ok: true, details: { totalPaginas, arquivosProcessados, avisos } };
}
