import { describe, it, expect } from "vitest";
import { encryptRefreshToken, decryptRefreshToken, bufferToPgBytea } from "../src/security/tokenEncryption.js";

const KEY = "11".repeat(32); // 64 hex chars = 32 bytes

describe("tokenEncryption", () => {
  it("cifra e decifra de volta pro texto original", () => {
    const plaintext = "1//refresh-token-de-teste-do-google";
    const encrypted = encryptRefreshToken(plaintext, KEY);
    expect(decryptRefreshToken(encrypted, KEY)).toBe(plaintext);
  });

  it("produz ciphertexts diferentes pra mesma entrada (IV aleatório)", () => {
    const a = encryptRefreshToken("mesmo-texto", KEY);
    const b = encryptRefreshToken("mesmo-texto", KEY);
    expect(a.equals(b)).toBe(false);
  });

  it("rejeita decifrar com chave errada (authTag não bate)", () => {
    const encrypted = encryptRefreshToken("segredo", KEY);
    const otherKey = "f".repeat(64);
    expect(() => decryptRefreshToken(encrypted, otherKey)).toThrow();
  });

  it("bufferToPgBytea produz o formato \\x... esperado pelo Postgres", () => {
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    expect(bufferToPgBytea(buf)).toBe("\\xdeadbeef");
  });
});
