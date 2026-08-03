import type { StageInput, StageOutput } from "./types.js";
import { loadEnv } from "../../shared/env.js";
import { createOpenAIClient, embedTextsWithUsage, estimateCostUsd } from "../../integrations/openai.js";
import { assertBudgetAvailable } from "./budgetGuard.js";

const AGENT_NAME = "indexacao";

// Limite de segurança por chamada à API de embeddings -- bem abaixo do teto
// real da OpenAI (2048 inputs), só evita um payload gigante numa única
// requisição quando um proponente tem centenas de chunks.
const BATCH_SIZE = 100;

// Última etapa do pipeline de PDF (ADR-9): gera o embedding de cada chunk
// ainda não indexado, pra Fase 7 (agentes) poder fazer busca híbrida
// filtrada por proponent_id em vez de ler o documento inteiro de novo.
export async function runIndexacaoStage(input: StageInput): Promise<StageOutput> {
  const { chunks } = await input.internalApi.listChunksNeedingEmbedding(input.applicationId);

  if (chunks.length === 0) {
    input.logger.info({}, "indexacao_no_chunks");
    return { ok: true, details: { chunksIndexados: 0 } };
  }

  await assertBudgetAvailable(input, AGENT_NAME);

  const env = loadEnv();
  const client = createOpenAIClient(env);

  let chunksIndexados = 0;
  let totalInputTokens = 0;
  const avisos: string[] = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    let embeddings: number[][];
    try {
      const result = await embedTextsWithUsage(
        client,
        env.OPENAI_EMBEDDING_MODEL,
        batch.map((c) => c.texto),
      );
      embeddings = result.embeddings;
      totalInputTokens += result.usage.inputTokens;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      avisos.push(`lote ${i}-${i + batch.length}: ${message}`);
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j]!;
      try {
        await input.internalApi.saveChunkEmbedding({
          chunkId: chunk.chunkId,
          embedding: embeddings[j]!,
          modelo: env.OPENAI_EMBEDDING_MODEL,
        });
        chunksIndexados += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        avisos.push(`chunk ${chunk.chunkId}: ${message}`);
      }
    }
  }

  // Rastreamento de custo (ADR-10) ficava totalmente de fora aqui -- a
  // etapa que mais gasta em embeddings (até centenas de chunks por
  // proponente) nunca aparecia na aba Custos. Uma linha só por execução,
  // igual ao padrão das outras etapas.
  if (totalInputTokens > 0) {
    const cost = estimateCostUsd(env.OPENAI_EMBEDDING_MODEL, { inputTokens: totalInputTokens, outputTokens: 0 });
    await input.internalApi
      .saveCostEntry({
        editalId: input.editalId,
        proponentId: input.applicationId,
        stage: AGENT_NAME,
        model: env.OPENAI_EMBEDDING_MODEL,
        inputTokens: totalInputTokens,
        outputTokens: 0,
        cost,
      })
      .catch((err) => input.logger.warn({ err }, "cost_entry_save_failed"));
  }

  if (avisos.length > 0) {
    input.logger.warn({ avisos }, "indexacao_avisos");
  }
  if (chunksIndexados === 0) {
    throw new Error(`Nenhum chunk pôde ser indexado: ${avisos.join(" | ")}`);
  }

  input.logger.info({ chunksIndexados }, "indexacao_completed");
  return { ok: true, details: { chunksIndexados, avisos } };
}
