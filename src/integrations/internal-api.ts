import { createHmac } from "node:crypto";
import { Agent, fetch as undiciFetch } from "undici";
import type { Env } from "../shared/env.js";
import type { PipelineStage, StageState } from "../shared/queueNames.js";

// O fetch nativo do Node (undici embutido) tem um headersTimeout padrão de
// 300s que NÃO é coberto por AbortSignal.timeout -- ele mata a conexão antes
// do nosso próprio timeout, mesmo com a chamada ainda progredindo do outro
// lado. executeSyncRun roda minutos (varredura + download + upload arquivo a
// arquivo), então usa o fetch + Agent do pacote "undici" (não o fetch global
// do Node) com timeouts bem maiores -- misturar um Agent de um "undici" só
// instalado via npm com o fetch nativo do Node quebra ("invalid
// onRequestStart method"), já que as duas cópias podem divergir de versão;
// usando fetch e Agent do mesmo pacote isso nunca acontece. As demais
// chamadas (rápidas) continuam no fetch global padrão.
const longRunningAgent = new Agent({ headersTimeout: 20 * 60 * 1000, bodyTimeout: 20 * 60 * 1000 });

// Cliente HTTP assinado (HMAC) pro app web pnabavaliacaopro. É o único jeito
// deste backend gravar dado privilegiado: o Lovable Cloud não expõe
// service_role, então quem tem acesso ao Postgres é o próprio app web — este
// backend só pede pra ele escrever, autenticado por segredo compartilhado
// (nunca por token de usuário, já que o Worker roda sem sessão).
export interface CreateJobInput {
  editalId: string;
  applicationId: string;
  triggeredBy: string | null;
}

export interface UpdateStageInput {
  jobId: string;
  stage: PipelineStage;
  state: StageState;
  attempts?: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  retryable?: boolean;
  preserved?: boolean;
}

export interface CreateDriveConnectionInput {
  connectedBy: string;
  googleEmail: string | null;
  refreshTokenEncryptedHex: string;
  scope: string;
}

export interface CreateDriveSourceInput {
  connectionId: string;
  editalId: string;
  driveFolderId: string;
  folderName: string | null;
}

export interface CreateSyncRunInput {
  driveSourceId: string;
  editalId: string;
  kind: "baseline" | "sync";
  triggeredBy: string;
}

export interface FinishSyncRunInput {
  syncRunId: string;
  status: "concluido" | "erro";
  stats?: Record<string, number> | null;
  errorMessage?: string | null;
}

export interface ExecuteSyncRunInput {
  syncRunId: string;
  // access_token do Google já renovado pelo Worker (curta duração, só
  // drive.readonly) -- o app web nunca guarda client secret do Google, só
  // usa o token pronto pra falar com a Drive API.
  accessToken: string;
}

export interface ProponentFile {
  fileId: string;
  fileVersionId: string;
  nome: string;
  mimeType: string | null;
  tipoDocumental: string;
  // URL assinada de leitura (Supabase Storage, ~15min) -- o Worker baixa
  // direto dela, o app web nunca manda o binário por dentro do JSON.
  downloadUrl: string;
}

export type PageQuality = "boa" | "baixa" | "imagem_pura";

export interface DocumentPageInput {
  numeroPagina: number;
  texto: string;
  textLength: number;
  printableRatio: number | null;
  qualidade: PageQuality;
  precisaVisao: boolean;
}

export interface SaveDocumentPagesInput {
  fileId: string;
  fileVersionId: string;
  pages: DocumentPageInput[];
}

export class InternalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InternalApiError";
  }
}

function sign(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

async function signedPost<T>(
  env: Pick<Env, "INTERNAL_API_BASE_URL" | "RAILWAY_INTERNAL_SECRET">,
  path: string,
  payload: unknown,
  opts?: { timeoutMs?: number; longRunning?: boolean },
): Promise<T> {
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = sign(env.RAILWAY_INTERNAL_SECRET, timestamp, body);

  const url = `${env.INTERNAL_API_BASE_URL}${path}`;
  const headers = {
    "content-type": "application/json",
    "x-internal-timestamp": timestamp,
    "x-internal-signature": signature,
  };
  const signal = opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;

  // Tipos de fetch/Agent do pacote "undici" e os do fetch global do Node
  // (undici-types, via @types/node) não são estruturalmente idênticos --
  // por isso os dois branches ficam separados em vez de uma chamada
  // genérica só com "dispatcher" condicional.
  const res = opts?.longRunning
    ? await undiciFetch(url, { method: "POST", headers, body, signal, dispatcher: longRunningAgent })
    : await fetch(url, { method: "POST", headers, body, signal });

  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new InternalApiError(
      typeof json.message === "string" ? json.message : `Falha na chamada interna: ${res.status}`,
      res.status,
    );
  }
  return json as T;
}

export function createInternalApiClient(
  env: Pick<Env, "INTERNAL_API_BASE_URL" | "RAILWAY_INTERNAL_SECRET">,
) {
  return {
    createJob: (input: CreateJobInput) =>
      signedPost<{ jobId: string }>(env, "/api/internal/jobs", input),
    updateStage: (input: UpdateStageInput) =>
      signedPost<{ ok: true; jobStatus: StageState }>(
        env,
        `/api/internal/jobs/${input.jobId}/stages/${input.stage}`,
        {
          state: input.state,
          attempts: input.attempts,
          startedAt: input.startedAt,
          finishedAt: input.finishedAt,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          retryable: input.retryable,
          preserved: input.preserved,
        },
      ),
    createDriveConnection: (input: CreateDriveConnectionInput) =>
      signedPost<{ id: string }>(env, "/api/internal/drive-connections", input),
    createDriveSource: (input: CreateDriveSourceInput) =>
      signedPost<{ id: string; folderName: string | null }>(
        env,
        "/api/internal/drive-sources",
        input,
      ),
    createSyncRun: (input: CreateSyncRunInput) =>
      signedPost<{ id: string }>(env, "/api/internal/sync-runs", input),
    finishSyncRun: (input: FinishSyncRunInput) =>
      signedPost<{ ok: true }>(env, `/api/internal/sync-runs/${input.syncRunId}/finish`, {
        status: input.status,
        stats: input.stats,
        errorMessage: input.errorMessage,
      }),
    // A varredura recursiva de verdade (listar Drive, baixar, hash, gravar
    // proponents/files/file_versions/sync_changes) roda do lado do app web,
    // que é quem tem supabaseAdmin -- este backend só entrega o access_token
    // já renovado e espera a chamada terminar (pode levar minutos numa pasta
    // grande, por isso timeout maior que o padrão HMAC).
    executeSyncRun: (input: ExecuteSyncRunInput) =>
      signedPost<{ ok: true; stats: Record<string, unknown> }>(
        env,
        `/api/internal/sync-runs/${input.syncRunId}/execute`,
        { accessToken: input.accessToken },
        { timeoutMs: 20 * 60 * 1000, longRunning: true },
      ),
    listProponentFiles: (proponentId: string) =>
      signedPost<{ files: ProponentFile[] }>(
        env,
        `/api/internal/proponents/${proponentId}/files`,
        {},
      ),
    saveDocumentPages: (input: SaveDocumentPagesInput) =>
      signedPost<{ ok: true; saved: number }>(env, "/api/internal/document-pages", input),
  };
}

export type InternalApiClient = ReturnType<typeof createInternalApiClient>;
