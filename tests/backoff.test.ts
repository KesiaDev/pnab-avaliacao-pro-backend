import { describe, it, expect } from "vitest";
import { computeBackoffDelayMs, hasExceededMaxAttempts } from "../src/domain/backoff.js";

describe("computeBackoffDelayMs", () => {
  it("cresce exponencialmente a partir de 2000ms", () => {
    expect(computeBackoffDelayMs(1)).toBe(2000);
    expect(computeBackoffDelayMs(2)).toBe(4000);
    expect(computeBackoffDelayMs(3)).toBe(8000);
  });

  it("rejeita attemptNumber menor que 1", () => {
    expect(() => computeBackoffDelayMs(0)).toThrow();
  });
});

describe("hasExceededMaxAttempts", () => {
  it("respeita MAX_STAGE_ATTEMPTS", () => {
    expect(hasExceededMaxAttempts(3, 3)).toBe(false);
    expect(hasExceededMaxAttempts(4, 3)).toBe(true);
  });
});
