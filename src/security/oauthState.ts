import { createHmac, timingSafeEqual } from "node:crypto";

// O fluxo OAuth do Google é redirect-based: o callback (GET, sem header
// Authorization) precisa recuperar editalId/userId sem sessão de servidor.
// Em vez de guardar estado em memória/Redis (que não sobreviveria a um
// restart do Worker/API entre o start e o callback), assinamos o payload e
// devolvemos ele mesmo como o parâmetro "state" -- o Google só ecoa de volta
// o que mandamos, então isso é seguro desde que a assinatura seja verificada
// no callback (impede um state forjado apontar pra outro edital/usuário).
export interface OAuthStatePayload {
  editalId: string;
  userId: string;
  issuedAt: number;
}

const MAX_STATE_AGE_MS = 10 * 60_000;

export function signOAuthState(payload: OAuthStatePayload, secret: string): string {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyOAuthState(state: string, secret: string): OAuthStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature) throw new Error("state malformado.");

  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error("state com assinatura inválida.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthStatePayload;
  if (Date.now() - payload.issuedAt > MAX_STATE_AGE_MS) {
    throw new Error("state expirado -- inicie a conexão de novo.");
  }
  return payload;
}
