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
  fastify.register(healthRoutes, { appVersion: opts.appVersion, checkReady: opts.checkReady });
  fastify.register(jobsRoutes, opts.jobs);

  // Contrato de erro único — nunca stack trace pro cliente, log completo só
  // no Pino server-side (ver Contratos no plano).
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "unhandled_error");
    if (error.validation) {
      return reply.code(400).send({ error: { code: "bad_request", message: error.message } });
    }
    const statusCode = error.statusCode ?? 500;
    return reply.code(statusCode).send({
      error: { code: statusCode === 500 ? "internal_error" : "request_error", message: error.message },
    });
  });

  return fastify;
}
