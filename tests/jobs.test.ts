import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { buildServer } from "../src/api/server.js";
import { createLogger } from "../src/observability/logger.js";
import { createTestJwks } from "./helpers/jwt.js";

const ISSUER = "https://test.supabase.co/auth/v1";

async function buildTestServer(overrides: {
  verifyMembership?: (userId: string, workspaceId: string, accessToken: string) => Promise<boolean>;
  createProcessingJob?: (input: unknown) => Promise<{ jobId: string }>;
  enqueueStage?: (input: unknown) => Promise<void>;
}) {
  const jwks = await createTestJwks();
  const server = buildServer({
    logger: createLogger({ NODE_ENV: "test" }),
    appVersion: "0.0.0-test",
    frontendOrigin: "http://localhost:5173",
    jwt: { getKey: jwks.getKey, issuer: ISSUER },
    checkReady: async () => true,
    jobs: {
      verifyMembership: overrides.verifyMembership ?? (async () => true),
      createProcessingJob: overrides.createProcessingJob ?? (async () => ({ jobId: "job-1" })),
      enqueueStage: overrides.enqueueStage ?? (async () => undefined),
    },
  });
  return { server, sign: jwks.sign };
}

const workspaceId = randomUUID();
const applicationId = "app-mock-1";

describe("POST /workspaces/:workspaceId/applications/:applicationId/process", () => {
  it("rejeita sem token (ADR-1 nunca processa sem auth)", async () => {
    const { server } = await buildTestServer({});
    const response = await server.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/applications/${applicationId}/process`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejeita quando o usuário não é membro do workspace", async () => {
    const { server, sign } = await buildTestServer({ verifyMembership: async () => false });
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });
    const response = await server.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/applications/${applicationId}/process`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it("enfileira e devolve job_id rapidamente sem esperar processamento (ADR-1)", async () => {
    const enqueueStage = vi.fn(async () => undefined);
    const { server, sign } = await buildTestServer({
      createProcessingJob: async () => ({ jobId: "job-abc" }),
      enqueueStage,
    });
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });

    const start = Date.now();
    const response = await server.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/applications/${applicationId}/process`,
      headers: { authorization: `Bearer ${token}` },
      payload: { payload: { note: "teste" } },
    });
    const elapsedMs = Date.now() - start;

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ job_id: "job-abc" });
    expect(elapsedMs).toBeLessThan(500);
    expect(enqueueStage).toHaveBeenCalledTimes(1);
  });

  it("rejeita workspaceId inválido (contrato de erro { error: { code, message } })", async () => {
    const { server, sign } = await buildTestServer({});
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });
    const response = await server.inject({
      method: "POST",
      url: `/workspaces/not-a-uuid/applications/${applicationId}/process`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_params");
  });
});
