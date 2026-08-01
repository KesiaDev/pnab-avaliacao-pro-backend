import { describe, it, expect, vi } from "vitest";
import { processSyncJob } from "../src/worker/processSyncJob.js";
import { createLogger } from "../src/observability/logger.js";

function baseDeps() {
  return {
    logger: createLogger({ NODE_ENV: "test" }),
    getGoogleAccessToken: vi.fn(async () => "fresh-access-token"),
    executeSyncRun: vi.fn(async () => ({ stats: { arquivosNovos: 3 } })),
    finishSyncRun: vi.fn(async () => undefined),
  };
}

const jobData = {
  syncRunId: "sync-1",
  driveSourceId: "source-1",
  editalId: "edital-1",
  refreshTokenEncryptedHex: "\\xdeadbeef",
};

describe("processSyncJob", () => {
  it("renova o access_token e delega a varredura real pro app web", async () => {
    const deps = baseDeps();
    await processSyncJob(jobData, deps);
    expect(deps.getGoogleAccessToken).toHaveBeenCalledWith("\\xdeadbeef");
    expect(deps.executeSyncRun).toHaveBeenCalledWith({
      syncRunId: "sync-1",
      accessToken: "fresh-access-token",
    });
    expect(deps.finishSyncRun).not.toHaveBeenCalled();
  });

  it("marca erro e relança quando a renovação do token falha", async () => {
    const deps = baseDeps();
    deps.getGoogleAccessToken.mockRejectedValueOnce(new Error("refresh_token inválido"));
    await expect(processSyncJob(jobData, deps)).rejects.toThrow("refresh_token inválido");
    expect(deps.executeSyncRun).not.toHaveBeenCalled();
    expect(deps.finishSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({
        syncRunId: "sync-1",
        status: "erro",
        errorMessage: "refresh_token inválido",
      }),
    );
  });

  it("marca erro e relança quando a execução no app web falha", async () => {
    const deps = baseDeps();
    deps.executeSyncRun.mockRejectedValueOnce(new Error("falha na varredura"));
    await expect(processSyncJob(jobData, deps)).rejects.toThrow("falha na varredura");
    expect(deps.finishSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "erro", errorMessage: "falha na varredura" }),
    );
  });
});
