// Primeira etapa real do pipeline (Fase 2/3 desta sessão) — só prova o
// padrão fila -> Worker -> endpoint interno HMAC -> job_stages/Realtime, sem
// nenhuma integração externa ainda. As etapas seguintes (download,
// extracao_textual, ...) entram na Fase 5/6, cada uma com este mesmo
// contrato de entrada/saída.
export interface StageInput {
  editalId: string;
  applicationId: string;
}

export interface StageOutput {
  ok: true;
}

export async function runInventarioStage(_input: StageInput): Promise<StageOutput> {
  return { ok: true };
}
