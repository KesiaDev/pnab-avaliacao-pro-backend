import { createHash } from "node:crypto";

// Serialização determinística: chaves de objeto ordenadas recursivamente,
// pra que o mesmo conteúdo lógico produza sempre o mesmo hash independente
// da ordem em que as chaves foram inseridas (ver ADR-2 — nunca reprocessar
// etapa concluída com o mesmo hash de entrada).
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export function stableHash(input: unknown): string {
  const canonical = JSON.stringify(sortKeysDeep(input));
  return createHash("sha256").update(canonical).digest("hex");
}
