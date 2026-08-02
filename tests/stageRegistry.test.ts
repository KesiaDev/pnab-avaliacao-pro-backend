import { describe, it, expect } from "vitest";
import { getStageHandler } from "../src/worker/stageRegistry.js";
import { PIPELINE_STAGES } from "../src/shared/queueNames.js";

describe("getStageHandler", () => {
  it("retorna um handler pra cada etapa do contrato (PIPELINE_STAGES)", () => {
    for (const stage of PIPELINE_STAGES) {
      expect(getStageHandler(stage)).toBeTypeOf("function");
    }
  });

  it("lança erro claro pra uma etapa fora do contrato", () => {
    // @ts-expect-error -- "inexistente" nunca é um PipelineStage de verdade,
    // é exatamente o caso que este teste cobre (defesa contra typo/nome
    // novo esquecido no registry).
    expect(() => getStageHandler("inexistente")).toThrow(
      'Stage "inexistente" ainda não implementado nesta fase.',
    );
  });
});
