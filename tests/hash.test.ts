import { describe, it, expect } from "vitest";
import { stableHash } from "../src/domain/hash.js";

describe("stableHash", () => {
  it("produz o mesmo hash independente da ordem das chaves", () => {
    const a = stableHash({ workspaceId: "w1", applicationId: "a1", payload: { x: 1, y: 2 } });
    const b = stableHash({ applicationId: "a1", payload: { y: 2, x: 1 }, workspaceId: "w1" });
    expect(a).toBe(b);
  });

  it("produz hashes diferentes pra conteúdo diferente", () => {
    const a = stableHash({ workspaceId: "w1", payload: { x: 1 } });
    const b = stableHash({ workspaceId: "w1", payload: { x: 2 } });
    expect(a).not.toBe(b);
  });

  it("é estável e determinístico entre chamadas repetidas", () => {
    const input = { a: [1, 2, 3], b: { nested: true } };
    expect(stableHash(input)).toBe(stableHash(input));
  });
});
