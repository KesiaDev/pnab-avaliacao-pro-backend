import { describe, it, expect } from "vitest";
import { buildServer } from "../src/api/server.js";
import { createLogger } from "../src/observability/logger.js";
import { createTestJwks } from "./helpers/jwt.js";
import { driveOptionsStub } from "./helpers/driveOptionsStub.js";

async function buildTestServer(checkReady: () => Promise<boolean>) {
  const { getKey } = await createTestJwks();
  return buildServer({
    logger: createLogger({ NODE_ENV: "test" }),
    appVersion: "0.0.0-test",
    frontendOrigin: "http://localhost:5173",
    jwt: { getKey, issuer: "https://test.supabase.co/auth/v1" },
    checkReady,
    jobs: {
      findApplicationEdital: async () => ({ editalId: "edital-1" }),
      createProcessingJob: async () => ({ jobId: "job-1" }),
      enqueueFirstStage: async () => undefined,
    },
    drive: driveOptionsStub(),
  });
}

describe("GET /health", () => {
  it("responde 200 sem checar dependências externas", async () => {
    const server = await buildTestServer(async () => {
      throw new Error("checkReady não deveria ser chamado por /health");
    });
    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", version: "0.0.0-test" });
  });

  it("também responde em /v1/health (contrato consumido pelo app web)", async () => {
    const server = await buildTestServer(async () => true);
    const response = await server.inject({ method: "GET", url: "/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", version: "0.0.0-test" });
  });
});

describe("GET /ready", () => {
  it("responde 200 quando as dependências estão OK", async () => {
    const server = await buildTestServer(async () => true);
    const response = await server.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
  });

  it("responde 503 quando as dependências estão indisponíveis", async () => {
    const server = await buildTestServer(async () => false);
    const response = await server.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
  });
});
