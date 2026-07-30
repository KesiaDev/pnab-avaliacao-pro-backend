// Único stage real desta fase — prova o padrão (hash, idempotência,
// retry/backoff, DLQ) sem depender de nenhuma integração externa ainda. Os
// 18 stages reais (Fase 6/7) seguem exatamente este mesmo contrato de
// entrada/saída.
export interface StageInput {
  workspaceId: string;
  applicationId: string;
  payload: unknown;
}

export interface StageOutput {
  ok: true;
  echoedPayload: unknown;
}

export async function runNoopStage(input: StageInput): Promise<StageOutput> {
  return { ok: true, echoedPayload: input.payload };
}
