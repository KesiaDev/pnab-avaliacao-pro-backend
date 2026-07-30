import pino from "pino";
import type { Env } from "../shared/env.js";

// Campos de correlação padrão em todo log (request/job/stage/application/edital
// id) — nunca PII. Cada chamador passa só os campos que tiver disponíveis via
// child logger, nunca loga corpo de documento ou dado pessoal do proponente.
export function createLogger(env: Pick<Env, "NODE_ENV">) {
  return pino({
    level: env.NODE_ENV === "test" ? "silent" : "info",
    transport:
      env.NODE_ENV === "development"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
    redact: ["req.headers.authorization", "*.token", "*.password", "*.serviceRoleKey"],
  });
}

export type Logger = ReturnType<typeof createLogger>;
