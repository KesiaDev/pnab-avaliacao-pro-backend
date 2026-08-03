import { describe, it, expect, vi } from "vitest";
import { createLogger } from "../src/observability/logger.js";
import { assertBudgetAvailable } from "../src/worker/stages/budgetGuard.js";

function makeInput(getCostStatus: () => Promise<unknown>) {
  return {
    editalId: "edital-1",
    applicationId: "proponent-1",
    internalApi: { getCostStatus: vi.fn(getCostStatus) } as never,
    logger: createLogger({ NODE_ENV: "test" }),
  };
}

describe("assertBudgetAvailable", () => {
  it("não bloqueia quando budget_total não está configurado (0), mesma convenção do front-end", async () => {
    const input = makeInput(async () => ({
      budgetTotal: 0,
      editalConsumed: 500,
      limitPerApplication: 0,
      applicationConsumed: 500,
      blockOnExceed: true,
    }));
    await expect(assertBudgetAvailable(input, "teste")).resolves.toBeUndefined();
  });

  it("não bloqueia quando block_on_exceed está desligado, mesmo acima do orçamento", async () => {
    const input = makeInput(async () => ({
      budgetTotal: 10,
      editalConsumed: 999,
      limitPerApplication: 0,
      applicationConsumed: 0,
      blockOnExceed: false,
    }));
    await expect(assertBudgetAvailable(input, "teste")).resolves.toBeUndefined();
  });

  it("bloqueia quando o consumo do edital atinge o orçamento configurado", async () => {
    const input = makeInput(async () => ({
      budgetTotal: 100,
      editalConsumed: 100,
      limitPerApplication: 0,
      applicationConsumed: 0,
      blockOnExceed: true,
    }));
    await expect(assertBudgetAvailable(input, "teste")).rejects.toThrow("Orçamento do edital excedido");
  });

  it("bloqueia quando o consumo do proponente atinge o limite por proponente", async () => {
    const input = makeInput(async () => ({
      budgetTotal: 0,
      editalConsumed: 0,
      limitPerApplication: 5,
      applicationConsumed: 5,
      blockOnExceed: true,
    }));
    await expect(assertBudgetAvailable(input, "teste")).rejects.toThrow(
      "Limite de custo por proponente excedido",
    );
  });

  it("não bloqueia quando o consumo está abaixo dos dois limites", async () => {
    const input = makeInput(async () => ({
      budgetTotal: 100,
      editalConsumed: 50,
      limitPerApplication: 10,
      applicationConsumed: 3,
      blockOnExceed: true,
    }));
    await expect(assertBudgetAvailable(input, "teste")).resolves.toBeUndefined();
  });
});
