import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { JWTVerifyGetKey } from "jose";
import { verifyAccessToken, AuthError, type AuthenticatedUser } from "../../security/jwt.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

export interface AuthPluginOptions {
  getKey: JWTVerifyGetKey;
  issuer: string;
}

// Plugin opt-in (preHandler: [fastify.authenticate]) em vez de hook global —
// rotas públicas (/health, /ready) nunca precisam de token, e cada rota
// protegida declara isso explicitamente em vez de depender de uma allowlist
// de exceções.
const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  fastify.decorate("authenticate", async (request, reply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Token ausente." } });
    }
    const token = header.slice("Bearer ".length);
    try {
      request.user = await verifyAccessToken(token, opts.getKey, opts.issuer);
    } catch (err) {
      const message = err instanceof AuthError ? err.message : "Token inválido.";
      return reply.code(401).send({ error: { code: "unauthorized", message } });
    }
  });
};

export default fp(authPlugin, { name: "auth-plugin" });
