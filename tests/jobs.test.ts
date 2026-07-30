import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { buildServer } from "../src/api/server.js";
import { createLogger } from "../src/observability/logger.js";
import { createTestJwks } from "./helpers/jwt.js";
import { driveOptionsStub } from "./helpers/driveOptionsStub.js";

const ISSUER = "https://test.supabase.co/auth/v1";

async function buildTestServer(overrides: {
  findApplicationEdital?: (
    applicationId: string,
    accessToken: string,
  ) => Promise<{ editalId: string } | null>;
  createProcessingJob?: (input: unknown) => Promise<{ jobId: string }>;
  enqueueFirstStage?: (input: unknown) => Promise<void>;
}) {
  const jwks = await createTestJwks();
  const server = buildServer({
    logger: createLogger({ NODE_ENV: "test" }),
    appVersion: "0.0.0-test",
    frontendOrigin: "http://localhost:5173",
    jwt: { getKey: jwks.getKey, issuer: ISSUER },
    checkReady: async () => true,
    jobs: {
      findApplicationEdital:
        overrides.findApplicationEdital ?? (async () => ({ editalId: randomUUID() })),
      createProcessingJob: overrides.createProcessingJob ?? (async () => ({ jobId: "job-1" })),
      enqueueFirstStage: overrides.enqueueFirstStage ?? (async () => undefined),
    },
    drive: driveOptionsStub(),
  });
  return { server, sign: jwks.sign };
}

const applicationId = randomUUID();

describe("POST /v1/applications/:applicationId/process", () => {
  it("rejeita sem token (ADR-1 nunca processa sem auth)", async () => {
    const { server } = await buildTestServer({});
    const response = await server.inject({
      method: "POST",
      url: `/v1/applications/${applicationId}/process`,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("unauthorized");
  });

  it("responde 404 quando a candidatura não existe ou não é visível via RLS", async () => {
    const { server, sign } = await buildTestServer({ findApplicationEdital: async () => null });
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });
    const response = await server.inject({
      method: "POST",
      url: `/v1/applications/${applicationId}/process`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("enfileira e devolve jobId rapidamente sem esperar processamento (ADR-1)", async () => {
    const enqueueFirstStage = vi.fn(async () => undefined);
    const { server, sign } = await buildTestServer({
      createProcessingJob: async () => ({ jobId: "job-abc" }),
      enqueueFirstStage,
    });
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });

    const start = Date.now();
    const response = await server.inject({
      method: "POST",
      url: `/v1/applications/${applicationId}/process`,
      headers: { authorization: `Bearer ${token}` },
    });
    const elapsedMs = Date.now() - start;

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ jobId: "job-abc" });
    expect(elapsedMs).toBeLessThan(500);
    expect(enqueueFirstStage).toHaveBeenCalledTimes(1);
  });

  it("rejeita applicationId inválido com forma de erro plana (code/message)", async () => {
    const { server, sign } = await buildTestServer({});
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });
    const response = await server.inject({
      method: "POST",
      url: "/v1/applications/not-a-uuid/process",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("invalid_params");
  });
});
