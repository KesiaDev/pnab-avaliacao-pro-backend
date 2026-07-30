import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey } from "jose";

// Gera um par de chaves só pra teste e um JWKS local (sem rede, sem depender
// do Supabase estar no ar) -- é o "getKey" injetável de src/security/jwt.ts.
export async function createTestJwks(): Promise<{
  getKey: JWTVerifyGetKey;
  sign: (payload: Record<string, unknown>, opts?: { issuer?: string; expiresIn?: string }) => Promise<string>;
}> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const kid = "test-key-1";
  const getKey = createLocalJWKSet({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] });

  const sign = async (
    payload: Record<string, unknown>,
    opts: { issuer?: string; expiresIn?: string } = {},
  ) =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt()
      .setIssuer(opts.issuer ?? "https://test.supabase.co/auth/v1")
      .setExpirationTime(opts.expiresIn ?? "1h")
      .sign(privateKey);

  return { getKey, sign };
}
