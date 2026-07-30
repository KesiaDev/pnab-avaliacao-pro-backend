// Backoff exponencial com base de 2s, usado tanto pela config do BullMQ
// (retry automático) quanto por qualquer retry manual fora da fila.
const BASE_DELAY_MS = 2000;

export function computeBackoffDelayMs(attemptNumber: number): number {
  if (attemptNumber < 1) throw new Error("attemptNumber deve ser >= 1");
  return BASE_DELAY_MS * 2 ** (attemptNumber - 1);
}

export function hasExceededMaxAttempts(attemptNumber: number, maxAttempts: number): boolean {
  return attemptNumber > maxAttempts;
}
