// Modelos de linguagem, raramente, "vazam" caracteres de outro alfabeto no
// meio de um texto em português (ex.: um trecho em devanágari/hindi no lugar
// de uma palavra comum) -- um defeito estocástico do próprio modelo, não um
// bug de codificação de texto. Detecta com uma lista de permissão (nunca
// tenta listar todo alfabeto problemático) do que é esperado em
// português-BR: Latin básico + Latin-1/Extended-A/B (cobre todos os acentos
// e ç), pontuação geral (aspas curvas, travessão, reticências) e símbolos de
// moeda comuns.
const ALLOWED_CHAR_RANGES = [
  "\\u0009\\u000A\\u000D", // tab, LF, CR
  "\\u0020-\\u007E", // Basic Latin (letras sem acento, dígitos, pontuação, símbolos)
  "\\u00A0-\\u024F", // Latin-1 Supplement + Latin Extended-A/B (á é í ó ú ã õ ç ü ...)
  "\\u2000-\\u206F", // General Punctuation (– — " " ‘ ’ … etc.)
  "\\u20A0-\\u20CF", // símbolos de moeda (€ etc. -- R$ já cai no Basic Latin)
].join("");

const UNEXPECTED_SCRIPT_RE = new RegExp(`[^${ALLOWED_CHAR_RANGES}]`);

export function containsUnexpectedScript(text: string): boolean {
  return UNEXPECTED_SCRIPT_RE.test(text);
}
