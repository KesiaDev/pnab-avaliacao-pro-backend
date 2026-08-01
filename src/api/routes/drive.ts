import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  fetchGoogleUserEmail,
  extractFolderId,
} from "../../integrations/googleOAuth.js";
import { signOAuthState, verifyOAuthState } from "../../security/oauthState.js";
import { encryptRefreshToken, bufferToPgBytea } from "../../security/tokenEncryption.js";
import type { InternalApiClient } from "../../integrations/internal-api.js";

export interface DriveRoutesOptions {
  google: { clientId: string; clientSecret: string; redirectUri: string };
  tokenEncryptionKey: string;
  frontendOrigin: string;
  internalApi: InternalApiClient;
  // A conexão Google é única por sistema (não por edital, ver
  // useActiveDriveConnection no app web) -- lida via RLS com o token do
  // usuário, nunca assumida a partir de um header.
  findActiveConnection: (accessToken: string) => Promise<{ id: string } | null>;
  findDriveSourceForEdital: (
    editalId: string,
    accessToken: string,
  ) => Promise<{ id: string } | null>;
  enqueueSync: (input: { syncRunId: string; driveSourceId: string; editalId: string }) => Promise<void>;
}

const startBodySchema = z.object({ editalId: z.string().uuid() });
const driveSourceParamsSchema = z.object({ editalId: z.string().uuid() });
const driveSourceBodySchema = z.object({ folderUrl: z.string().min(1) });
const syncParamsSchema = z.object({ editalId: z.string().uuid() });
// "sync" (não "incremental") -- bate com o check constraint real de
// sync_runs.kind no Supabase (ver supabase/migrations no repo web).
const syncBodySchema = z.object({ kind: z.enum(["baseline", "sync"]).default("sync") });

const driveRoutes: FastifyPluginAsync<DriveRoutesOptions> = async (fastify, opts) => {
  // ---------- Início do OAuth ----------
  fastify.post(
    "/v1/drive/oauth/start",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = startBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ code: "invalid_body", message: body.error.message });
      }
      const state = signOAuthState(
        { editalId: body.data.editalId, userId: request.user!.userId, issuedAt: Date.now() },
        opts.tokenEncryptionKey,
      );
      const url = buildGoogleAuthUrl(
        { GOOGLE_CLIENT_ID: opts.google.clientId, GOOGLE_REDIRECT_URI: opts.google.redirectUri },
        state,
      );
      return { url };
    },
  );

  // ---------- Callback do Google (sem auth: é o navegador sendo
  // redirecionado direto pelo Google, sem header Authorization) ----------
  fastify.get("/v1/drive/oauth/callback", async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };
    const fonteUrl = (editalId?: string) =>
      editalId
        ? `${opts.frontendOrigin}/editais/${editalId}/fonte-documental`
        : `${opts.frontendOrigin}/fonte-documental`;

    if (query.error) {
      return reply.redirect(`${fonteUrl()}?google_error=access_denied`);
    }
    if (!query.code || !query.state) {
      return reply.redirect(`${fonteUrl()}?google_error=missing_code`);
    }

    let statePayload: ReturnType<typeof verifyOAuthState>;
    try {
      statePayload = verifyOAuthState(query.state, opts.tokenEncryptionKey);
    } catch {
      return reply.redirect(`${fonteUrl()}?google_error=unauthorized`);
    }

    try {
      const tokens = await exchangeCodeForTokens(
        {
          GOOGLE_CLIENT_ID: opts.google.clientId,
          GOOGLE_CLIENT_SECRET: opts.google.clientSecret,
          GOOGLE_REDIRECT_URI: opts.google.redirectUri,
        },
        query.code,
      );
      if (!tokens.refresh_token) {
        return reply.redirect(`${fonteUrl(statePayload.editalId)}?google_error=no_refresh_token`);
      }
      const email = await fetchGoogleUserEmail(tokens.access_token);
      const encrypted = encryptRefreshToken(tokens.refresh_token, opts.tokenEncryptionKey);

      await opts.internalApi.createDriveConnection({
        connectedBy: statePayload.userId,
        googleEmail: email,
        refreshTokenEncryptedHex: bufferToPgBytea(encrypted),
        scope: tokens.scope,
      });

      return reply.redirect(`${fonteUrl(statePayload.editalId)}?connected=1`);
    } catch (err) {
      request.log.error({ err }, "drive_oauth_callback_failed");
      return reply.redirect(`${fonteUrl(statePayload.editalId)}?google_error=save_failed`);
    }
  });

  // ---------- Definir a pasta-fonte do edital ----------
  fastify.post(
    "/v1/editais/:editalId/drive-source",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = driveSourceParamsSchema.safeParse(request.params);
      const body = driveSourceBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({
          code: "invalid_params",
          message: (params.error ?? body.error)?.message ?? "Parâmetros inválidos.",
        });
      }

      const connection = await opts.findActiveConnection(request.user!.accessToken);
      if (!connection) {
        return reply.code(409).send({
          code: "no_active_connection",
          message: "Conecte uma conta Google antes de definir a pasta-fonte.",
        });
      }

      // TODO(próxima etapa da Fase 5): validar a pasta de verdade via Drive
      // API (fetchFolderMetadata) usando o access_token renovado da conexão,
      // antes de persistir. Por ora extrai o folderId e persiste direto --
      // suficiente pra fechar o contrato; a varredura recursiva completa
      // (baseline/incremental) é o próximo passo, feito pelo Worker.
      const folderId = extractFolderId(body.data.folderUrl);

      const source = await opts.internalApi.createDriveSource({
        connectionId: connection.id,
        editalId: params.data.editalId,
        driveFolderId: folderId,
        folderName: null,
      });

      return reply.code(201).send({ id: source.id, folderName: source.folderName });
    },
  );

  // ---------- Disparar sincronização ----------
  fastify.post(
    "/v1/editais/:editalId/sync",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = syncParamsSchema.safeParse(request.params);
      const body = syncBodySchema.safeParse(request.body ?? {});
      if (!params.success) {
        return reply.code(400).send({ code: "invalid_params", message: params.error.message });
      }

      const source = await opts.findDriveSourceForEdital(
        params.data.editalId,
        request.user!.accessToken,
      );
      if (!source) {
        return reply.code(409).send({
          code: "no_drive_source",
          message: "Defina a pasta-fonte deste edital antes de sincronizar.",
        });
      }

      const { id: syncRunId } = await opts.internalApi.createSyncRun({
        driveSourceId: source.id,
        editalId: params.data.editalId,
        kind: body.success ? body.data.kind : "sync",
        triggeredBy: request.user!.userId,
      });

      await opts.enqueueSync({ syncRunId, driveSourceId: source.id, editalId: params.data.editalId });

      return reply.code(202).send({ syncRunId });
    },
  );
};

export default driveRoutes;
