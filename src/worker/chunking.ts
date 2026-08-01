// Fragmentação por janela deslizante de palavras (ADR-9: 900–1400 tokens,
// overlap 120–200). Sem dependência de tokenizer real (evita trazer WASM
// pro Docker só pra isso) -- aproxima 1 token ≈ 4 caracteres, regra prática
// padrão o bastante pra dimensionar chunk sem estourar o limite de contexto
// do embedding (8191 tokens no text-embedding-3-small, muito acima do teto
// de 1400 usado aqui).
const CHARS_PER_TOKEN = 4;
const TARGET_TOKENS = 1200; // meio do intervalo 900–1400
const OVERLAP_TOKENS = 160; // meio do intervalo 120–200
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;

export interface PageForChunking {
  numeroPagina: number;
  texto: string;
}

export interface Chunk {
  texto: string;
  paginaInicial: number;
  paginaFinal: number;
  tokensEstimados: number;
}

interface Word {
  text: string;
  page: number;
}

// Junta todas as páginas de um arquivo (já em ordem) numa lista de palavras
// rotuladas com a página de origem -- é o que permite calcular
// pagina_inicial/pagina_final de cada chunk depois.
function toWords(pages: PageForChunking[]): Word[] {
  const words: Word[] = [];
  for (const page of pages) {
    for (const text of page.texto.split(/\s+/).filter(Boolean)) {
      words.push({ text, page: page.numeroPagina });
    }
  }
  return words;
}

export function chunkPages(pages: PageForChunking[]): Chunk[] {
  const words = toWords(pages);
  if (words.length === 0) return [];

  const chunks: Chunk[] = [];
  let start = 0;

  while (start < words.length) {
    let end = start;
    let chars = 0;
    while (end < words.length && chars < TARGET_CHARS) {
      chars += words[end]!.text.length + 1;
      end += 1;
    }

    const slice = words.slice(start, end);
    const texto = slice.map((w) => w.text).join(" ");
    chunks.push({
      texto,
      paginaInicial: slice[0]!.page,
      paginaFinal: slice[slice.length - 1]!.page,
      tokensEstimados: Math.ceil(texto.length / CHARS_PER_TOKEN),
    });

    if (end >= words.length) break;

    // Próximo chunk recua ~OVERLAP_CHARS a partir do fim do atual, sempre
    // avançando pelo menos 1 palavra pra garantir progresso.
    let back = end;
    let overlapChars = 0;
    while (back > start && overlapChars < OVERLAP_CHARS) {
      back -= 1;
      overlapChars += words[back]!.text.length + 1;
    }
    start = Math.max(back, start + 1);
  }

  return chunks;
}
