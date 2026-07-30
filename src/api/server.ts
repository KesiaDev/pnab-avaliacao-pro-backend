import Fastify, { type FastifyInstance, type FastifyBaseLogger, type FastifyError } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { JWTVerifyGetKey } from "jose";
import type { Logger } from "../observability/logger.js";
import authPlugin from "./plugins/auth.js";
import healthRoutes from "./routes/health.js";
import jobsRoutes, { type JobsRoutesOptions } from "./routes/jobs.js";

export interface BuildServerOptions {
  logger: Logger;
  appVersion: string;
  frontendOrigin: string;
  jwt: { getKey: JWTVerifyGetKey; issuer: string };
  checkReady: () => Promise<boolean>;
  jobs: JobsRoutesOptions;
}

// Fábrica pura (não dá listen) — permite testar com fastify.inject() sem
// abrir porta de rede, e reusar a mesma composição de plugins em produção.
export function buildServer(opts: BuildServerOptions): FastifyInstance {
  // Pino (nossa Logger) e o FastifyBaseLogger que o Fastify espera divergem
  // num detalhe de tipagem (msgPrefix) sem impacto em runtime -- Fastify usa
  // Pino internamente por padrão. Cast documentado, não um "unknown" real.
  const fastify = Fastify({
    loggerInstance: opts.logger as unknown as FastifyBaseLogger,
    bodyLimit: 1024 * 1024,
  });

  fastify.register(helmet);
  fastify.register(cors, { origin: opts.frontendOrigin });
  fastify.register(rateLimit, { max: 100, timeWindow: "1 minute" });

  fastify.register(authPlugin, { getKey: opts.jwt.getKey, issuer: opts.jwt.issuer });
  // Bare /health e /ready: usados pelo healthcheck do próprio Railway
  // (railway.json). /v1/health: mesma info, sob o contrato que o frontend
  // consome (ver editaisApi.health() em src/lib/api/endpoints.ts do app web).
  fastify.register(healthRoutes, { appVersion: opts.appVersion, checkReady: opts.checkReady });
  fastify.register(
    async (instance) => {
      instance.register(healthRoutes, { appVersion: opts.appVersion, checkReady: opts.checkReady });
    },
    { prefix: "/v1" },
  );
  fastify.register(jobsRoutes, opts.jobs);

  // Forma de erro plana, batendo com src/lib/api/errors.ts (toApiError) do
  // app web: { code, message, stage?, retryable?, preserved?, details? } —
  // nunca { error: {...} }, nunca stack trace pro cliente. Log completo só
  // no Pino server-side.
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "unhandled_error");
    if (error.validation) {
      return reply.code(400).send({ code: "bad_request", message: error.message });
    }
    const statusCode = error.statusCode ?? 500;
    return reply.code(statusCode).send({
      code: statusCode === 500 ? "internal_error" : "request_error",
      message: error.message,
      retryable: statusCode >= 500,
    });
  });

  return fastify;
}
