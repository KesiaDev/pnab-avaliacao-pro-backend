import type { StageInput, StageOutput } from "./types.js";

// Primeira etapa real do pipeline (Fase 2/3 desta sessão) — só prova o
// padrão fila -> Worker -> endpoint interno HMAC -> job_stages/Realtime, sem
// nenhuma integração externa ainda.
export async function runInventarioStage(_input: StageInput): Promise<StageOutput> {
  return { ok: true };
}
