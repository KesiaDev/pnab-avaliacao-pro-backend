import { describe, it, expect } from "vitest";
import { decideStageExecution } from "../src/domain/stageIdempotency.js";

describe("decideStageExecution (ADR-2: nunca reprocessar etapa concluída com o mesmo hash)", () => {
  it("roda quando não há tentativas anteriores", () => {
    expect(decideStageExecution([], "hash-1")).toEqual({ action: "run" });
  });

  it("pula quando já existe uma tentativa concluída com o mesmo hash", () => {
    const past = [{ inputHash: "hash-1", status: "concluido" as const }];
    expect(decideStageExecution(past, "hash-1")).toEqual({
      action: "skip",
      reason: "already_completed_same_hash",
    });
  });

  it("roda de novo se o hash mudou (entrada mudou)", () => {
    const past = [{ inputHash: "hash-1", status: "concluido" as const }];
    expect(decideStageExecution(past, "hash-2")).toEqual({ action: "run" });
  });

  it("roda de novo se a tentativa anterior com o mesmo hash falhou (falha não trava a etapa)", () => {
    const past = [{ inputHash: "hash-1", status: "erro" as const }];
    expect(decideStageExecution(past, "hash-1")).toEqual({ action: "run" });
  });

  it("roda de novo se a tentativa anterior ainda está em andamento", () => {
    const past = [{ inputHash: "hash-1", status: "em_andamento" as const }];
    expect(decideStageExecution(past, "hash-1")).toEqual({ action: "run" });
  });
});
