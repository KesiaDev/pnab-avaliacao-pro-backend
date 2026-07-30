import { describe, it, expect } from "vitest";
import { verifyAccessToken, AuthError } from "../src/security/jwt.js";
import { createTestJwks } from "./helpers/jwt.js";

const ISSUER = "https://test.supabase.co/auth/v1";

describe("verifyAccessToken", () => {
  it("aceita um token válido e devolve userId + accessToken", async () => {
    const { getKey, sign } = await createTestJwks();
    const token = await sign({ sub: "user-123" }, { issuer: ISSUER });

    const result = await verifyAccessToken(token, getKey, ISSUER);

    expect(result.userId).toBe("user-123");
    expect(result.accessToken).toBe(token);
  });

  it("rejeita token com issuer diferente", async () => {
    const { getKey, sign } = await createTestJwks();
    const token = await sign({ sub: "user-123" }, { issuer: "https://outro-issuer.example" });

    await expect(verifyAccessToken(token, getKey, ISSUER)).rejects.toThrow(AuthError);
  });

  it("rejeita token expirado", async () => {
    const { getKey, sign } = await createTestJwks();
    const token = await sign({ sub: "user-123" }, { issuer: ISSUER, expiresIn: "-10s" });

    await expect(verifyAccessToken(token, getKey, ISSUER)).rejects.toThrow(AuthError);
  });

  it("rejeita token sem claim 'sub'", async () => {
    const { getKey, sign } = await createTestJwks();
    const token = await sign({}, { issuer: ISSUER });

    await expect(verifyAccessToken(token, getKey, ISSUER)).rejects.toThrow(AuthError);
  });

  it("rejeita token assinado com outra chave (não confia em token forjado)", async () => {
    const { getKey } = await createTestJwks();
    const forger = await createTestJwks();
    const forgedToken = await forger.sign({ sub: "user-123" }, { issuer: ISSUER });

    await expect(verifyAccessToken(forgedToken, getKey, ISSUER)).rejects.toThrow(AuthError);
  });
});
