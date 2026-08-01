import type { InternalApiClient } from "../../integrations/internal-api.js";
import type { Logger } from "../../observability/logger.js";

// Cada etapa é stateless por desenho (ADR-2/ADR-3): não guarda nada em disco
// local entre etapas (um job de "download" e o próximo de "extracao_textual"
// podem nem rodar no mesmo container) -- tudo que uma etapa precisa, ela
// busca de novo via internalApi; tudo que produz, ela grava de volta por ali
// antes de terminar.
export interface StageInput {
  editalId: string;
  applicationId: string; // == proponent_id no banco (ver internal-jobs.server.ts)
  internalApi: InternalApiClient;
  logger: Logger;
}

export interface StageOutput {
  ok: true;
  details?: Record<string, unknown>;
}
