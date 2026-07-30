import { describe, it, expect, vi } from "vitest";
import { processStageJob, getNextStage } from "../src/worker/processStageJob.js";
import { createLogger } from "../src/observability/logger.js";
import type { ApplicationStageJobData } from "../src/shared/applicationQueue.js";

function makeJobData(overrides: Partial<ApplicationStageJobData> = {}): ApplicationStageJobData {
  return {
    jobId: "job-1",
    editalId: "edital-1",
    applicationId: "app-1",
    stage: "inventario",
    ...overrides,
  };
}

function makeDeps() {
  return {
    reportStageState: vi.fn(async () => undefined),
    enqueueNextStage: vi.fn(async () => undefined),
    logger: createLogger({ NODE_ENV: "test" }),
  };
}

describe("processStageJob", () => {
  it("reporta 'processando' e depois 'concluido', e enfileira a próxima etapa", async () => {
    const deps = makeDeps();
    await processStageJob(makeJobData(), 1, deps);

    expect(deps.reportStageState).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ stage: "inventario", state: "processando", attempts: 1 }),
    );
    expect(deps.reportStageState).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ stage: "inventario", state: "concluido", attempts: 1 }),
    );
    expect(deps.enqueueNextStage).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-1", stage: "download" }),
    );
  });

  it("getNextStage não retorna nada depois da última etapa do pipeline (parecer)", () => {
    expect(getNextStage("parecer")).toBeUndefined();
    expect(getNextStage("inventario")).toBe("download");
  });

  it("reporta 'falhou' e relança a exceção pro BullMQ decidir o retry, sem enfileirar a próxima etapa", async () => {
    const deps = makeDeps();
    const data = makeJobData({ stage: "download" }); // não implementado nesta fase

    await expect(processStageJob(data, 1, deps)).rejects.toThrow(
      'Stage "download" ainda não implementado nesta fase.',
    );
    expect(deps.reportStageState).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ state: "falhou", errorMessage: expect.stringContaining("download") }),
    );
    expect(deps.enqueueNextStage).not.toHaveBeenCalled();
  });
});
