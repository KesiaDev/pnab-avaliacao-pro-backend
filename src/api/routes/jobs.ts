import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { PIPELINE_STAGES, type PipelineStage, type StageState } from "../../shared/queueNames.js";

const applicationParamsSchema = z.object({ applicationId: z.string().uuid() });
const jobParamsSchema = z.object({ jobId: z.string().uuid() });
const retryStageBodySchema = z.object({ stage: z.enum(PIPELINE_STAGES) });

export interface JobSummary {
  id: string;
  editalId: string;
  applicationId: string;
  stages: { stage: PipelineStage; orderIndex: number; state: StageState }[];
}

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
  // Leituras (RLS) usadas por cancel/retry/retry-stage pra descobrir qual
  // job/etapa mexer sem precisar de outro endpoint interno só pra isso.
  findLatestJobForApplication: (
    applicationId: string,
    accessToken: string,
  ) => Promise<JobSummary | null>;
  findJobById: (jobId: string, accessToken: string) => Promise<JobSummary | null>;
  cancelJob: (jobId: string) => Promise<void>;
  resetStage: (input: { jobId: string; stage: PipelineStage }) => Promise<void>;
  enqueueStage: (input: {
    jobId: string;
    editalId: string;
    applicationId: string;
    stage: PipelineStage;
  }) => Promise<void>;
}

// Acha a primeira etapa ainda não concluída, em ordem -- é o que "Repetir"
// (nível do job, sem etapa explícita) reenfileira. Cobre tanto o caso de um
// job "fantasma" que nunca chegou a rodar (todas as etapas em na_fila,
// começa do início) quanto o de uma etapa específica que falhou no meio do
// pipeline (retoma dali, sem repetir o que já concluiu).
function findNextStageToRun(job: JobSummary): PipelineStage | undefined {
  const ordered = [...job.stages].sort((a, b) => a.orderIndex - b.orderIndex);
  return ordered.find((s) => s.state !== "concluido")?.stage;
}

// ADR-1: estes handlers nunca esperam o processamento -- só validam,
// mexem no estado (via endpoint interno do app web, que tem acesso
// privilegiado) e enfileiram no BullMQ. O trabalho de verdade acontece no
// Worker.
const jobsRoutes: FastifyPluginAsync<JobsRoutesOptions> = async (fastify, opts) => {
  fastify.post(
    "/v1/applications/:applicationId/process",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = applicationParamsSchema.safeParse(request.params);
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

  fastify.post(
    "/v1/applications/:applicationId/cancel",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = applicationParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ code: "invalid_params", message: params.error.message });
      }
      const job = await opts.findLatestJobForApplication(
        params.data.applicationId,
        request.user!.accessToken,
      );
      if (!job) {
        return reply.code(404).send({
          code: "not_found",
          message: "Nenhum processamento encontrado pra esta candidatura.",
        });
      }
      await opts.cancelJob(job.id);
      return reply.code(200).send({ ok: true });
    },
  );

  fastify.post(
    "/v1/applications/:applicationId/retry",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = applicationParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ code: "invalid_params", message: params.error.message });
      }
      const job = await opts.findLatestJobForApplication(
        params.data.applicationId,
        request.user!.accessToken,
      );
      if (!job) {
        return reply.code(404).send({
          code: "not_found",
          message: "Nenhum processamento encontrado pra repetir.",
        });
      }
      const stage = findNextStageToRun(job);
      if (!stage) {
        return reply
          .code(409)
          .send({ code: "already_completed", message: "Todas as etapas já concluíram." });
      }
      await opts.resetStage({ jobId: job.id, stage });
      await opts.enqueueStage({
        jobId: job.id,
        editalId: job.editalId,
        applicationId: job.applicationId,
        stage,
      });
      return reply.code(200).send({ ok: true });
    },
  );

  fastify.post(
    "/v1/jobs/:jobId/retry-stage",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = jobParamsSchema.safeParse(request.params);
      const body = retryStageBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({
          code: "invalid_params",
          message: (params.error ?? body.error)?.message ?? "Parâmetros inválidos.",
        });
      }
      const job = await opts.findJobById(params.data.jobId, request.user!.accessToken);
      if (!job) {
        return reply.code(404).send({ code: "not_found", message: "Job não encontrado." });
      }
      await opts.resetStage({ jobId: job.id, stage: body.data.stage });
      await opts.enqueueStage({
        jobId: job.id,
        editalId: job.editalId,
        applicationId: job.applicationId,
        stage: body.data.stage,
      });
      return reply.code(200).send({ ok: true });
    },
  );
};

export default jobsRoutes;
