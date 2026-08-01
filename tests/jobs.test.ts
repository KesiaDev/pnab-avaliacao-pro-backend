import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { buildServer } from "../src/api/server.js";
import { createLogger } from "../src/observability/logger.js";
import { createTestJwks } from "./helpers/jwt.js";
import { driveOptionsStub } from "./helpers/driveOptionsStub.js";
import type { JobSummary } from "../src/api/routes/jobs.js";

const ISSUER = "https://test.supabase.co/auth/v1";

function makeJobSummary(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: "job-1",
    editalId: randomUUID(),
    applicationId: randomUUID(),
    stages: [
      { stage: "inventario", orderIndex: 0, state: "na_fila" },
      { stage: "download", orderIndex: 1, state: "na_fila" },
    ],
    ...overrides,
  };
}

async function buildTestServer(overrides: {
  findApplicationEdital?: (
    applicationId: string,
    accessToken: string,
  ) => Promise<{ editalId: string } | null>;
  createProcessingJob?: (input: unknown) => Promise<{ jobId: string }>;
  enqueueFirstStage?: (input: unknown) => Promise<void>;
  findLatestJobForApplication?: (
    applicationId: string,
    accessToken: string,
  ) => Promise<JobSummary | null>;
  findJobById?: (jobId: string, accessToken: string) => Promise<JobSummary | null>;
  cancelJob?: (jobId: string) => Promise<void>;
  resetStage?: (input: unknown) => Promise<void>;
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
      findApplicationEdital:
        overrides.findApplicationEdital ?? (async () => ({ editalId: randomUUID() })),
      createProcessingJob: overrides.createProcessingJob ?? (async () => ({ jobId: "job-1" })),
      enqueueFirstStage: overrides.enqueueFirstStage ?? (async () => undefined),
      findLatestJobForApplication:
        overrides.findLatestJobForApplication ?? (async () => makeJobSummary()),
      findJobById: overrides.findJobById ?? (async () => makeJobSummary()),
      cancelJob: overrides.cancelJob ?? (async () => undefined),
      resetStage: overrides.resetStage ?? (async () => undefined),
      enqueueStage: overrides.enqueueStage ?? (async () => undefined),
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

describe("POST /v1/applications/:applicationId/cancel", () => {
  it("responde 404 quando não há job pra essa candidatura", async () => {
    const { server, sign } = await buildTestServer({
      findLatestJobForApplication: async () => null,
    });
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });
    const response = await server.inject({
      method: "POST",
      url: `/v1/applications/${applicationId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("cancela o job mais recente da candidatura", async () => {
    const cancelJob = vi.fn(async () => undefined);
    const { server, sign } = await buildTestServer({
      findLatestJobForApplication: async () => makeJobSummary({ id: "job-xyz" }),
      cancelJob,
    });
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });
    const response = await server.inject({
      method: "POST",
      url: `/v1/applications/${applicationId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(cancelJob).toHaveBeenCalledWith("job-xyz");
  });
});

describe("POST /v1/applications/:applicationId/retry", () => {
  it("responde 404 quando não há job pra essa candidatura", async () => {
    const { server, sign } = await buildTestServer({
      findLatestJobForApplication: async () => null,
    });
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });
    const response = await server.inject({
      method: "POST",
      url: `/v1/applications/${applicationId}/retry`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("responde 409 quando todas as etapas já concluíram", async () => {
    const { server, sign } = await buildTestServer({
      findLatestJobForApplication: async () =>
        makeJobSummary({
          stages: [{ stage: "parecer", orderIndex: 10, state: "concluido" }],
        }),
    });
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });
    const response = await server.inject({
      method: "POST",
      url: `/v1/applications/${applicationId}/retry`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("already_completed");
  });

  it("reseta e reenfileira a primeira etapa não concluída (retoma sem repetir o que já passou)", async () => {
    const resetStage = vi.fn(async () => undefined);
    const enqueueStage = vi.fn(async () => undefined);
    const { server, sign } = await buildTestServer({
      findLatestJobForApplication: async () =>
        makeJobSummary({
          id: "job-retry",
          stages: [
            { stage: "inventario", orderIndex: 0, state: "concluido" },
            { stage: "download", orderIndex: 1, state: "concluido" },
            { stage: "extracao_textual", orderIndex: 2, state: "falhou" },
            { stage: "analise_visual_seletiva", orderIndex: 3, state: "na_fila" },
          ],
        }),
      resetStage,
      enqueueStage,
    });
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });
    const response = await server.inject({
      method: "POST",
      url: `/v1/applications/${applicationId}/retry`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(resetStage).toHaveBeenCalledWith({ jobId: "job-retry", stage: "extracao_textual" });
    expect(enqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-retry", stage: "extracao_textual" }),
    );
  });
});

describe("POST /v1/jobs/:jobId/retry-stage", () => {
  it("responde 404 quando o job não existe", async () => {
    const { server, sign } = await buildTestServer({ findJobById: async () => null });
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });
    const response = await server.inject({
      method: "POST",
      url: `/v1/jobs/${randomUUID()}/retry-stage`,
      headers: { authorization: `Bearer ${token}` },
      payload: { stage: "download" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("reseta e reenfileira exatamente a etapa pedida", async () => {
    const resetStage = vi.fn(async () => undefined);
    const enqueueStage = vi.fn(async () => undefined);
    const { server, sign } = await buildTestServer({
      findJobById: async () => makeJobSummary({ id: "job-42" }),
      resetStage,
      enqueueStage,
    });
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });
    const jobId = randomUUID();
    const response = await server.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/retry-stage`,
      headers: { authorization: `Bearer ${token}` },
      payload: { stage: "evidencias_a_c" },
    });
    expect(response.statusCode).toBe(200);
    expect(resetStage).toHaveBeenCalledWith({ jobId: "job-42", stage: "evidencias_a_c" });
    expect(enqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-42", stage: "evidencias_a_c" }),
    );
  });
});
