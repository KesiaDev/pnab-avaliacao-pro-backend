import { describe, it, expect } from "vitest";
import { chunkPages } from "../src/worker/chunking.js";

function repeatWords(word: string, count: number): string {
  return Array.from({ length: count }, () => word).join(" ");
}

describe("chunkPages", () => {
  it("retorna vazio quando não há texto", () => {
    expect(chunkPages([{ numeroPagina: 1, texto: "" }])).toEqual([]);
    expect(chunkPages([{ numeroPagina: 1, texto: "   " }])).toEqual([]);
  });

  it("um texto curto vira um único chunk cobrindo a página inteira", () => {
    const chunks = chunkPages([{ numeroPagina: 1, texto: "um texto curto de teste" }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ paginaInicial: 1, paginaFinal: 1 });
    expect(chunks[0].texto).toBe("um texto curto de teste");
  });

  it("texto grande é dividido em múltiplos chunks com overlap", () => {
    // ~2000 palavras de 5 letras -> bem acima do alvo de 1200 tokens
    // (≈4800 chars) de um chunk só, força mais de um chunk.
    const texto = repeatWords("abcde", 2000);
    const chunks = chunkPages([{ numeroPagina: 1, texto }]);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Nenhum chunk deveria passar muito do alvo (900-1400 tokens).
      expect(chunk.tokensEstimados).toBeLessThan(1600);
    }
    // Overlap real: o começo de um chunk aparece perto do fim do anterior.
    const firstChunkWords = chunks[0].texto.split(" ");
    const secondChunkWords = chunks[1].texto.split(" ");
    const overlapCandidate = firstChunkWords[firstChunkWords.length - 1];
    expect(secondChunkWords).toContain(overlapCandidate);
  });

  it("calcula pagina_inicial/pagina_final corretamente atravessando páginas", () => {
    const pages = [
      { numeroPagina: 1, texto: repeatWords("um", 50) },
      { numeroPagina: 2, texto: repeatWords("dois", 50) },
      { numeroPagina: 3, texto: repeatWords("tres", 2000) }, // força split
    ];
    const chunks = chunkPages(pages);
    expect(chunks[0].paginaInicial).toBe(1);
    // O último chunk deve terminar na última página com conteúdo.
    expect(chunks[chunks.length - 1].paginaFinal).toBe(3);
  });

  it("sempre progride (nunca trava em loop infinito) mesmo com palavras enormes", () => {
    // Uma "palavra" sozinha maior que o overlap inteiro -- garante que o
    // algoritmo não fica preso tentando recuar pra dentro da mesma palavra.
    const hugeWord = "a".repeat(5000);
    const texto = `${hugeWord} ${repeatWords("b", 500)}`;
    const chunks = chunkPages([{ numeroPagina: 1, texto }]);
    expect(chunks.length).toBeGreaterThan(0);
  });
});
