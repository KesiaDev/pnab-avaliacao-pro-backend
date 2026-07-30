import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { buildServer } from "../src/api/server.js";
import { createLogger } from "../src/observability/logger.js";
import { createTestJwks } from "./helpers/jwt.js";
import { driveOptionsStub, TEST_TOKEN_ENCRYPTION_KEY } from "./helpers/driveOptionsStub.js";
import { signOAuthState } from "../src/security/oauthState.js";
import type { DriveRoutesOptions } from "../src/api/routes/drive.js";

const ISSUER = "https://test.supabase.co/auth/v1";

async function buildTestServer(driveOverrides: Partial<DriveRoutesOptions> = {}) {
  const jwks = await createTestJwks();
  const server = buildServer({
    logger: createLogger({ NODE_ENV: "test" }),
    appVersion: "0.0.0-test",
    frontendOrigin: "https://app.test",
    jwt: { getKey: jwks.getKey, issuer: ISSUER },
    checkReady: async () => true,
    jobs: {
      findApplicationEdital: async () => ({ editalId: randomUUID() }),
      createProcessingJob: async () => ({ jobId: "job-1" }),
      enqueueFirstStage: async () => undefined,
    },
    drive: driveOptionsStub(driveOverrides),
  });
  return { server, sign: jwks.sign };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /v1/drive/oauth/start", () => {
  it("rejeita sem token", async () => {
    const { server } = await buildTestServer();
    const response = await server.inject({
      method: "POST",
      url: "/v1/drive/oauth/start",
      payload: { editalId: randomUUID() },
    });
    expect(response.statusCode).toBe(401);
  });

  it("devolve uma URL de autorização do Google contendo um state assinado", async () => {
    const { server, sign } = await buildTestServer();
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });
    const response = await server.inject({
      method: "POST",
      url: "/v1/drive/oauth/start",
      headers: { authorization: `Bearer ${token}` },
      payload: { editalId: randomUUID() },
    });
    expect(response.statusCode).toBe(200);
    const { url } = response.json();
    expect(url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    expect(url).toContain("state=");
    expect(url).toContain("access_type=offline");
  });
});

describe("GET /v1/drive/oauth/callback", () => {
  it("redireciona com google_error=access_denied quando o Google reporta erro", async () => {
    const { server } = await buildTestServer();
    const response = await server.inject({
      method: "GET",
      url: "/v1/drive/oauth/callback?error=access_denied",
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("google_error=access_denied");
  });

  it("redireciona com google_error=missing_code quando falta code/state", async () => {
    const { server } = await buildTestServer();
    const response = await server.inject({ method: "GET", url: "/v1/drive/oauth/callback" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("google_error=missing_code");
  });

  it("redireciona com google_error=unauthorized quando o state tem assinatura inválida", async () => {
    const { server } = await buildTestServer();
    const response = await server.inject({
      method: "GET",
      url: "/v1/drive/oauth/callback?code=abc&state=forjado.invalido",
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("google_error=unauthorized");
  });

  it("troca o code por tokens, cria a conexão e redireciona pra fonte-documental do edital com connected=1", async () => {
    const editalId = randomUUID();
    const state = signOAuthState({ editalId, userId: randomUUID(), issuedAt: Date.now() }, TEST_TOKEN_ENCRYPTION_KEY);
    const createDriveConnection = vi.fn(async () => ({ id: "conn-1" }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({
              access_token: "access-123",
              refresh_token: "refresh-456",
              expires_in: 3600,
              scope: "https://www.googleapis.com/auth/drive.readonly",
              token_type: "Bearer",
            }),
            { status: 200 },
          );
        }
        if (url.includes("googleapis.com/oauth2/v2/userinfo")) {
          return new Response(JSON.stringify({ email: "avaliadora@example.com" }), { status: 200 });
        }
        throw new Error(`fetch não esperado: ${url}`);
      }),
    );

    const { server } = await buildTestServer({ internalApi: { ...driveOptionsStub().internalApi, createDriveConnection } });
    const response = await server.inject({
      method: "GET",
      url: `/v1/drive/oauth/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`https://app.test/editais/${editalId}/fonte-documental?connected=1`);
    expect(createDriveConnection).toHaveBeenCalledWith(
      expect.objectContaining({ googleEmail: "avaliadora@example.com" }),
    );
  });
});

describe("POST /v1/editais/:editalId/drive-source", () => {
  it("responde 409 quando não há conexão Google ativa", async () => {
    const { server, sign } = await buildTestServer({ findActiveConnection: async () => null });
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });
    const response = await server.inject({
      method: "POST",
      url: `/v1/editais/${randomUUID()}/drive-source`,
      headers: { authorization: `Bearer ${token}` },
      payload: { folderUrl: "https://drive.google.com/drive/folders/abc123" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("no_active_connection");
  });

  it("extrai o folderId da URL e persiste via internalApi quando há conexão ativa", async () => {
    const createDriveSource = vi.fn(async () => ({ id: "source-1", folderName: null }));
    const { server, sign } = await buildTestServer({
      findActiveConnection: async () => ({ id: "conn-1" }),
      internalApi: { ...driveOptionsStub().internalApi, createDriveSource },
    });
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });
    const response = await server.inject({
      method: "POST",
      url: `/v1/editais/${randomUUID()}/drive-source`,
      headers: { authorization: `Bearer ${token}` },
      payload: { folderUrl: "https://drive.google.com/drive/folders/abc123" },
    });
    expect(response.statusCode).toBe(201);
    expect(createDriveSource).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "conn-1", driveFolderId: "abc123" }),
    );
  });
});

describe("POST /v1/editais/:editalId/sync", () => {
  it("responde 409 quando o edital ainda não tem pasta-fonte definida", async () => {
    const { server, sign } = await buildTestServer({ findDriveSourceForEdital: async () => null });
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });
    const response = await server.inject({
      method: "POST",
      url: `/v1/editais/${randomUUID()}/sync`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("no_drive_source");
  });

  it("cria o sync_run, enfileira e devolve syncRunId rapidamente", async () => {
    const enqueueSync = vi.fn(async () => undefined);
    const { server, sign } = await buildTestServer({
      findDriveSourceForEdital: async () => ({ id: "source-1" }),
      internalApi: { ...driveOptionsStub().internalApi, createSyncRun: async () => ({ id: "sync-xyz" }) },
      enqueueSync,
    });
    const token = await sign({ sub: randomUUID() }, { issuer: ISSUER });
    const response = await server.inject({
      method: "POST",
      url: `/v1/editais/${randomUUID()}/sync`,
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: "baseline" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ syncRunId: "sync-xyz" });
    expect(enqueueSync).toHaveBeenCalledWith(
      expect.objectContaining({ syncRunId: "sync-xyz", driveSourceId: "source-1" }),
    );
  });
});
