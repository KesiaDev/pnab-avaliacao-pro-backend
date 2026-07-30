import type { FastifyPluginAsync } from "fastify";

export interface HealthRoutesOptions {
  // Injetável pra teste — produção passa um ping real no Redis (ver
  // api/server.ts); teste passa um stub sem precisar de infraestrutura.
  checkReady: () => Promise<boolean>;
  appVersion: string;
}

const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (fastify, opts) => {
  // Liveness: processo está de pé, sem checar dependências externas.
  fastify.get("/health", async () => ({ status: "ok", version: opts.appVersion }));

  // Readiness: só responde 200 se as dependências (Redis etc.) estiverem OK —
  // usado pelo Railway pra saber se pode rotear tráfego pra esta instância.
  fastify.get("/ready", async (_request, reply) => {
    const ready = await opts.checkReady();
    if (!ready) {
      return reply.code(503).send({ status: "not_ready" });
    }
    return { status: "ready" };
  });
};

export default healthRoutes;
