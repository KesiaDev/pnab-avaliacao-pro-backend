import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

function getKey(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, "hex");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY deve decodificar pra 32 bytes.");
  return key;
}

// Criptografa o refresh_token do Google antes de mandar pro endpoint interno
// -- ele nunca trafega nem é persistido em texto plano. iv + authTag +
// ciphertext concatenados, mesmo esquema já usado no repo web (ver
// google-oauth.server.ts lá) pra o formato ficar compatível se algum dia
// precisar decifrar dos dois lados.
export function encryptRefreshToken(plaintext: string, hexKey: string): Buffer {
  const key = getKey(hexKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decryptRefreshToken(blob: Buffer, hexKey: string): string {
  const key = getKey(hexKey);
  const iv = blob.subarray(0, 12);
  const authTag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// Supabase/PostgREST não aceita Buffer bruto em JSON: bytea trafega como
// string hex no formato \x.... (mesma convenção do repo web).
export function bufferToPgBytea(buf: Buffer): string {
  return `\\x${buf.toString("hex")}`;
}

export function pgByteaToBuffer(hex: string): Buffer {
  return Buffer.from(hex.replace(/^\\x/, ""), "hex");
}
