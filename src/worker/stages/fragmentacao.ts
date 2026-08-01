import type { StageInput, StageOutput } from "./types.js";
import { chunkPages } from "../chunking.js";
import type { DocumentPageForChunking } from "../../integrations/internal-api.js";

// Fragmenta o texto já extraído (extracao_textual) em chunks de 900–1400
// tokens com overlap 120–200 (ADR-9) -- nunca lê PDF nem chama Poppler
// aqui, só opera sobre document_pages.texto já persistido.
export async function runFragmentacaoStage(input: StageInput): Promise<StageOutput> {
  const { pages } = await input.internalApi.listDocumentPages(input.applicationId);

  if (pages.length === 0) {
    input.logger.info({}, "fragmentacao_no_pages");
    return { ok: true, details: { chunksGerados: 0 } };
  }

  const pagesByFile = new Map<string, { fileVersionId: string; pages: DocumentPageForChunking[] }>();
  for (const page of pages) {
    const entry = pagesByFile.get(page.fileId) ?? { fileVersionId: page.fileVersionId, pages: [] };
    entry.pages.push(page);
    pagesByFile.set(page.fileId, entry);
  }

  let chunksGerados = 0;
  const avisos: string[] = [];

  for (const [fileId, { fileVersionId, pages: filePages }] of pagesByFile) {
    try {
      const ordered = [...filePages].sort((a, b) => a.numeroPagina - b.numeroPagina);
      const chunks = chunkPages(ordered);
      if (chunks.length === 0) continue;

      await input.internalApi.saveDocumentChunks({
        fileId,
        fileVersionId,
        chunks: chunks.map((c, idx) => ({
          paginaInicial: c.paginaInicial,
          paginaFinal: c.paginaFinal,
          ordem: idx,
          texto: c.texto,
          tokensEstimados: c.tokensEstimados,
        })),
      });
      chunksGerados += chunks.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      avisos.push(`arquivo ${fileId}: ${message}`);
    }
  }

  if (avisos.length > 0) {
    input.logger.warn({ avisos }, "fragmentacao_avisos");
  }
  if (chunksGerados === 0 && avisos.length > 0) {
    throw new Error(`Nenhum arquivo pôde ser fragmentado: ${avisos.join(" | ")}`);
  }

  input.logger.info({ chunksGerados }, "fragmentacao_completed");
  return { ok: true, details: { chunksGerados, avisos } };
}
