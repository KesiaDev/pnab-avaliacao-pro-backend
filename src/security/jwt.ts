import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";

export interface AuthenticatedUser {
  userId: string;
  claims: JWTPayload;
  accessToken: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

// getKey é injetável de propósito: produção usa createRemoteJWKSet contra o
// SUPABASE_JWKS_URL real; testes usam createLocalJWKSet com uma chave gerada
// na hora, sem depender de rede nem do Supabase estar no ar.
export async function verifyAccessToken(
  token: string,
  getKey: JWTVerifyGetKey,
  issuer: string,
): Promise<AuthenticatedUser> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, getKey, { issuer }));
  } catch (err) {
    throw new AuthError(err instanceof Error ? err.message : "Token inválido.");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new AuthError("Token sem claim 'sub' (user id).");
  }
  return { userId: payload.sub, claims: payload, accessToken: token };
}

export function createSupabaseJwksResolver(jwksUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUrl));
}
