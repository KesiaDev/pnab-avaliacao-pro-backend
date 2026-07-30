import { createHmac } from "node:crypto";
import type { Env } from "../shared/env.js";
import type { PipelineStage, StageState } from "../shared/queueNames.js";

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
  kind: "baseline" | "incremental";
  triggeredBy: string;
}

export interface FinishSyncRunInput {
  syncRunId: string;
  status: "concluido" | "erro";
  stats?: Record<string, number> | null;
  errorMessage?: string | null;
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
): Promise<T> {
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = sign(env.RAILWAY_INTERNAL_SECRET, timestamp, body);

  const res = await fetch(`${env.INTERNAL_API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-timestamp": timestamp,
      "x-internal-signature": signature,
    },
    body,
  });

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
  };
}

export type InternalApiClient = ReturnType<typeof createInternalApiClient>;
