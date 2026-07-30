import { describe, it, expect, vi } from "vitest";
import { processSyncJob } from "../src/worker/processSyncJob.js";
import { createLogger } from "../src/observability/logger.js";

describe("processSyncJob", () => {
  it("finaliza o sync_run como concluído com stats zeradas (stub desta fase)", async () => {
    const finishSyncRun = vi.fn(async () => undefined);
    await processSyncJob(
      { syncRunId: "sync-1", driveSourceId: "source-1", editalId: "edital-1" },
      { logger: createLogger({ NODE_ENV: "test" }), finishSyncRun },
    );
    expect(finishSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({ syncRunId: "sync-1", status: "concluido" }),
    );
  });

  it("finaliza como erro e relança quando finishSyncRun falha ao gravar sucesso", async () => {
    const finishSyncRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("falha de rede"))
      .mockResolvedValueOnce(undefined);
    await expect(
      processSyncJob(
        { syncRunId: "sync-1", driveSourceId: "source-1", editalId: "edital-1" },
        { logger: createLogger({ NODE_ENV: "test" }), finishSyncRun },
      ),
    ).rejects.toThrow("falha de rede");
    expect(finishSyncRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "erro", errorMessage: "falha de rede" }),
    );
  });
});
