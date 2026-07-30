import { describe, it, expect, vi } from "vitest";
import { processStageJob } from "../src/worker/processStageJob.js";
import { createLogger } from "../src/observability/logger.js";
import type { ApplicationStageJobData } from "../src/shared/applicationQueue.js";
import type { PastStageAttempt } from "../src/domain/stageIdempotency.js";

function makeJobData(overrides: Partial<ApplicationStageJobData> = {}): ApplicationStageJobData {
  return {
    jobId: "job-1",
    workspaceId: "ws-1",
    applicationId: "app-1",
    stageName: "noop",
    payload: { hello: "world" },
    ...overrides,
  };
}

function makeDeps(pastAttempts: PastStageAttempt[] = []) {
  const recordAttemptStart = vi.fn(async () => ({ attemptId: "attempt-1" }));
  const recordAttemptResult = vi.fn(async () => undefined);
  const markJobStatus = vi.fn(async () => undefined);
  const deps = {
    fetchPastAttempts: vi.fn(async () => pastAttempts),
    recordAttemptStart,
    recordAttemptResult,
    markJobStatus,
    logger: createLogger({ NODE_ENV: "test" }),
  };
  return deps;
}

describe("processStageJob", () => {
  it("executa a etapa, grava sucesso e marca o job como concluído", async () => {
    const deps = makeDeps([]);
    await processStageJob(makeJobData(), deps);

    expect(deps.recordAttemptStart).toHaveBeenCalledTimes(1);
    expect(deps.recordAttemptResult).toHaveBeenCalledWith(
      "attempt-1",
      expect.objectContaining({ status: "concluido" }),
    );
    expect(deps.markJobStatus).toHaveBeenCalledWith("job-1", "concluido");
  });

  it("pula a execução (ADR-2) quando já existe tentativa concluída com o mesmo hash", async () => {
    const { stableHash } = await import("../src/domain/hash.js");
    const data = makeJobData();
    const inputHash = stableHash({
      workspaceId: data.workspaceId,
      applicationId: data.applicationId,
      stageName: data.stageName,
      payload: data.payload,
    });
    const deps = makeDeps([{ inputHash, status: "concluido" }]);

    await processStageJob(data, deps);

    expect(deps.recordAttemptStart).not.toHaveBeenCalled();
    expect(deps.markJobStatus).not.toHaveBeenCalled();
  });

  it("registra erro e relança a exceção pro BullMQ decidir o retry", async () => {
    const deps = makeDeps([]);
    const data = makeJobData({ stageName: "extract_text" }); // não implementado nesta fase

    await expect(processStageJob(data, deps)).rejects.toThrow(
      'Stage "extract_text" ainda não implementado nesta fase.',
    );
    expect(deps.recordAttemptResult).toHaveBeenCalledWith(
      "attempt-1",
      expect.objectContaining({ status: "erro" }),
    );
    expect(deps.markJobStatus).not.toHaveBeenCalled();
  });
});
