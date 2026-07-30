import { describe, it, expect, vi } from "vitest";
import { signOAuthState, verifyOAuthState } from "../src/security/oauthState.js";

const SECRET = "segredo-de-teste-para-assinar-o-state";

describe("oauthState", () => {
  it("assina e verifica um state válido, recuperando o payload original", () => {
    const state = signOAuthState({ editalId: "edital-1", userId: "user-1", issuedAt: Date.now() }, SECRET);
    const payload = verifyOAuthState(state, SECRET);
    expect(payload.editalId).toBe("edital-1");
    expect(payload.userId).toBe("user-1");
  });

  it("rejeita state assinado com outro segredo (forjado)", () => {
    const state = signOAuthState({ editalId: "e1", userId: "u1", issuedAt: Date.now() }, SECRET);
    expect(() => verifyOAuthState(state, "outro-segredo")).toThrow();
  });

  it("rejeita state malformado (sem separador)", () => {
    expect(() => verifyOAuthState("nao-eh-um-state-valido", SECRET)).toThrow();
  });

  it("rejeita state com payload adulterado mesmo mantendo a assinatura original", () => {
    const state = signOAuthState({ editalId: "e1", userId: "u1", issuedAt: Date.now() }, SECRET);
    const [, signature] = state.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ editalId: "outro-edital", userId: "u1", issuedAt: Date.now() }),
      "utf8",
    ).toString("base64url");
    expect(() => verifyOAuthState(`${forgedBody}.${signature}`, SECRET)).toThrow();
  });

  it("rejeita state expirado", () => {
    vi.useFakeTimers();
    try {
      const state = signOAuthState({ editalId: "e1", userId: "u1", issuedAt: Date.now() }, SECRET);
      vi.advanceTimersByTime(11 * 60_000);
      expect(() => verifyOAuthState(state, SECRET)).toThrow(/expirado/);
    } finally {
      vi.useRealTimers();
    }
  });
});
