import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const paramsSchema = z.object({ applicationId: z.string().uuid() });

export interface JobsRoutesOptions {
  // Busca o edital_id do proponente via RLS (o cliente escopado ao usuário
  // já garante que só volta linha se o usuário tiver permissão de leitura) —
  // não existe checagem de papel separada: a visibilidade da linha via RLS
  // já é a autorização (ver ADR revisado: tenancy única, sem
  // organizations/workspaces).
  findApplicationEdital: (
    applicationId: string,
    accessToken: string,
  ) => Promise<{ editalId: string } | null>;
  createProcessingJob: (input: {
    editalId: string;
    applicationId: string;
    triggeredBy: string;
  }) => Promise<{ jobId: string }>;
  enqueueFirstStage: (input: {
    jobId: string;
    editalId: string;
    applicationId: string;
  }) => Promise<void>;
}

// ADR-1: este handler nunca espera o processamento — só valida, cria o job
// (via endpoint interno do app web, que tem acesso privilegiado) e enfileira
// a primeira etapa. O trabalho de verdade acontece no Worker.
const jobsRoutes: FastifyPluginAsync<JobsRoutesOptions> = async (fastify, opts) => {
  fastify.post(
    "/v1/applications/:applicationId/process",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ code: "invalid_params", message: params.error.message });
      }

      const userId = request.user!.userId;
      const accessToken = request.user!.accessToken;
      const { applicationId } = params.data;

      const application = await opts.findApplicationEdital(applicationId, accessToken);
      if (!application) {
        return reply.code(404).send({
          code: "not_found",
          message: "Candidatura não encontrada ou sem permissão de acesso.",
        });
      }

      const { jobId } = await opts.createProcessingJob({
        editalId: application.editalId,
        applicationId,
        triggeredBy: userId,
      });
      await opts.enqueueFirstStage({ jobId, editalId: application.editalId, applicationId });

      return reply.code(202).send({ jobId });
    },
  );
};

export default jobsRoutes;
