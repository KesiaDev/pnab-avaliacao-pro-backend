import type { Logger } from "../observability/logger.js";
import type { DriveSyncJobData } from "../shared/driveSyncQueue.js";

export interface SyncDeps {
  // Renova o access_token do Google a partir do refresh_token cifrado da
  // conexão -- decifra (TOKEN_ENCRYPTION_KEY) e chama o endpoint de refresh
  // do Google, isolado aqui pra o núcleo continuar testável sem HTTP real.
  getGoogleAccessToken: (refreshTokenEncryptedHex: string) => Promise<string>;
  // A varredura recursiva de verdade roda do lado do app web (só ele tem
  // acesso admin ao Postgres/Storage) -- este Worker só entrega o
  // access_token já pronto e espera o resultado.
  executeSyncRun: (input: {
    syncRunId: string;
    accessToken: string;
  }) => Promise<{ stats: Record<string, unknown> }>;
  finishSyncRun: (input: {
    syncRunId: string;
    status: "concluido" | "erro";
    stats?: Record<string, number> | null;
    errorMessage?: string | null;
  }) => Promise<void>;
  logger: Logger;
}

// Núcleo do Worker pra sync do Drive, isolado do BullMQ de propósito (mesmo
// padrão de processStageJob.ts). O app web (executeSyncRun) já grava o
// status final de sync_runs no caminho feliz E no caminho de erro conhecido
// (ver drive-sync-executor.server.ts) -- o finishSyncRun aqui é só rede de
// segurança pra falha de rede/timeout entre Worker e app web, onde a linha
// ficaria presa em "em_andamento" pra sempre sem isso.
export async function processSyncJob(data: DriveSyncJobData, deps: SyncDeps): Promise<void> {
  deps.logger.info({ syncRunId: data.syncRunId }, "sync_run_started");
  try {
    const accessToken = await deps.getGoogleAccessToken(data.refreshTokenEncryptedHex);
    const { stats } = await deps.executeSyncRun({ syncRunId: data.syncRunId, accessToken });
    deps.logger.info({ syncRunId: data.syncRunId, stats }, "sync_run_completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.error({ syncRunId: data.syncRunId, err }, "sync_run_failed");
    await deps.finishSyncRun({ syncRunId: data.syncRunId, status: "erro", errorMessage: message });
    throw err;
  }
}
