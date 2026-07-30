import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { PipelineStage } from "../../shared/queueNames.js";

const paramsSchema = z.object({
  workspaceId: z.string().uuid(),
  applicationId: z.string().min(1),
});
const bodySchema = z.object({ payload: z.unknown().optional() }).default({});

export interface JobsRoutesOptions {
  verifyMembership: (userId: string, workspaceId: string, accessToken: string) => Promise<boolean>;
  createProcessingJob: (input: {
    workspaceId: string;
    applicationId: string;
    createdBy: string;
  }) => Promise<{ jobId: string }>;
  enqueueStage: (input: {
    jobId: string;
    workspaceId: string;
    applicationId: string;
    stageName: PipelineStage;
    payload: unknown;
  }) => Promise<void>;
}

// ADR-1: este handler nunca espera o processamento — só valida, grava o job
// como "queued" e enfileira. O trabalho de verdade acontece no Worker.
const jobsRoutes: FastifyPluginAsync<JobsRoutesOptions> = async (fastify, opts) => {
  fastify.post(
    "/workspaces/:workspaceId/applications/:applicationId/process",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .code(400)
          .send({ error: { code: "invalid_params", message: params.error.message } });
      }
      const body = bodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: { code: "invalid_body", message: body.error.message } });
      }

      // fastify.authenticate já rejeitou a requisição com 401 antes de chegar
      // aqui se request.user não estivesse definido.
      const userId = request.user!.userId;
      const accessToken = request.user!.accessToken;
      const { workspaceId, applicationId } = params.data;

      const isMember = await opts.verifyMembership(userId, workspaceId, accessToken);
      if (!isMember) {
        return reply
          .code(403)
          .send({ error: { code: "forbidden", message: "Sem acesso a este workspace." } });
      }

      const { jobId } = await opts.createProcessingJob({
        workspaceId,
        applicationId,
        createdBy: userId,
      });
      await opts.enqueueStage({
        jobId,
        workspaceId,
        applicationId,
        stageName: "noop",
        payload: body.data.payload,
      });

      return reply.code(202).send({ job_id: jobId });
    },
  );
};

export default jobsRoutes;
