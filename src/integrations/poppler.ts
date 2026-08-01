import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const execFileAsync = promisify(execFile);

// PDFs de teste do plano vão até ~50MB/150 páginas -- o maxBuffer padrão do
// child_process (1MB) truncaria a saída do pdftotext bem antes disso.
const MAX_BUFFER = 80 * 1024 * 1024;

export async function getPdfPageCount(pdfPath: string): Promise<number> {
  const { stdout } = await execFileAsync("pdfinfo", [pdfPath], { maxBuffer: MAX_BUFFER });
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  if (!match) throw new Error("pdfinfo não retornou contagem de páginas.");
  return Number(match[1]);
}

// pdftotext separa páginas por form-feed (\f); a última página também
// termina com um \f, o que gera um segmento vazio no fim -- descartado.
export async function extractPdfPagesText(pdfPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"], {
    maxBuffer: MAX_BUFFER,
  });
  const pages = stdout.split("\f");
  if (pages.length > 0 && pages[pages.length - 1] === "") pages.pop();
  return pages;
}

// Renderiza só a página pedida (nunca o PDF inteiro, ver ADR-9) em PNG.
// "-singlefile" é essencial aqui: sem ele, o nome do arquivo de saída do
// pdftoppm leva um sufixo de número de página cuja largura de zero-padding
// depende da faixa pedida (comportamento não-óbvio e não documentado o
// bastante pra arriscar sem poder testar Poppler localmente) -- com
// "-singlefile" o resultado é sempre exatamente "<prefix>.png", sem
// ambiguidade.
export async function renderPdfPageToPng(
  pdfPath: string,
  pageNumber: number,
  dpi = 150,
): Promise<Buffer> {
  const outputPrefix = join(dirname(pdfPath), `page-${pageNumber}`);
  await execFileAsync(
    "pdftoppm",
    [
      "-png",
      "-f",
      String(pageNumber),
      "-l",
      String(pageNumber),
      "-r",
      String(dpi),
      "-singlefile",
      pdfPath,
      outputPrefix,
    ],
    { maxBuffer: MAX_BUFFER },
  );
  return readFile(`${outputPrefix}.png`);
}

// Poppler só trabalha com arquivo em disco (não stream/buffer direto) --
// cria um diretório temporário isolado por chamada e limpa mesmo se algo
// lançar no meio.
export async function withTempPdf<T>(
  binary: Buffer,
  fn: (pdfPath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pnab-pdf-"));
  const filePath = join(dir, "doc.pdf");
  try {
    await writeFile(filePath, binary);
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
