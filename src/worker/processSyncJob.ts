import type { Logger } from "../observability/logger.js";
import type { DriveSyncJobData } from "../shared/driveSyncQueue.js";

export interface SyncDeps {
  finishSyncRun: (input: {
    syncRunId: string;
    status: "concluido" | "erro";
    stats?: Record<string, number> | null;
    errorMessage?: string | null;
  }) => Promise<void>;
  logger: Logger;
}

// Stub desta fase (mesma lógica do stage "inventario" em processStageJob):
// prova o contrato fila -> Worker -> endpoint interno -> sync_runs/Realtime,
// sem varredura recursiva de verdade ainda. A varredura completa (listar
// subpastas, baixar arquivo, SHA-256, criar proponents/files/file_versions,
// classificar mudanças) é o próximo passo desta mesma fase, feito aqui
// dentro -- o contrato de entrada/saída (DriveSyncJobData -> stats) já fica
// fixado agora pra não precisar renomear nada depois.
export async function processSyncJob(data: DriveSyncJobData, deps: SyncDeps): Promise<void> {
  deps.logger.info({ syncRunId: data.syncRunId }, "sync_stub_run");
  try {
    await deps.finishSyncRun({
      syncRunId: data.syncRunId,
      status: "concluido",
      stats: {
        subpastas: 0,
        proponentesNovos: 0,
        arquivosNovos: 0,
        arquivosAlterados: 0,
        arquivosRenomeados: 0,
        arquivosMovidos: 0,
        arquivosExcluidos: 0,
        arquivosInalterados: 0,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.finishSyncRun({ syncRunId: data.syncRunId, status: "erro", errorMessage: message });
    throw err;
  }
}
