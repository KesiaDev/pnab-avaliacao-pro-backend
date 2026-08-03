import OpenAI from "openai";
import type { Env } from "../shared/env.js";

export function createOpenAIClient(env: Pick<Env, "OPENAI_API_KEY" | "OPENAI_PROJECT_ID">): OpenAI {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY não configurada.");
  }
  return new OpenAI({ apiKey: env.OPENAI_API_KEY, project: env.OPENAI_PROJECT_ID });
}

export async function embedTexts(
  client: OpenAI,
  model: string,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await client.embeddings.create({ model, input: texts });
  return res.data.map((d) => d.embedding);
}

export interface JsonCompletionUsage {
  inputTokens: number;
  cachedTokens?: number;
  outputTokens: number;
}

// Igual a embedTexts(), mas também devolve o uso de tokens -- indexacao.ts
// precisa disso pra registrar o custo real da indexação (antes ficava de
// fora do rastreamento de custos inteiramente, já que embedTexts() descarta
// o campo usage da resposta da OpenAI).
export async function embedTextsWithUsage(
  client: OpenAI,
  model: string,
  texts: string[],
): Promise<{ embeddings: number[][]; usage: JsonCompletionUsage }> {
  if (texts.length === 0) {
    return { embeddings: [], usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 } };
  }
  const res = await client.embeddings.create({ model, input: texts });
  return {
    embeddings: res.data.map((d) => d.embedding),
    usage: { inputTokens: res.usage?.total_tokens ?? 0, cachedTokens: 0, outputTokens: 0 },
  };
}

export interface JsonCompletionResult<T> {
  result: T;
  usage: JsonCompletionUsage;
}

// Modo JSON nativo da API da OpenAI (response_format json_object) -- mais
// confiável que validar/reenviar em texto livre como o gateway legado
// fazia, já que o modelo é forçado a produzir JSON sintaticamente válido.
export async function completeJSON<T>(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<JsonCompletionResult<T>> {
  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
  });
  const content = res.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Resposta vazia da OpenAI.");
  }
  let result: T;
  try {
    result = JSON.parse(content) as T;
  } catch {
    throw new Error("Resposta da OpenAI não é um JSON válido.");
  }
  return {
    result,
    usage: {
      inputTokens: res.usage?.prompt_tokens ?? 0,
      cachedTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
    },
  };
}

// Preços aproximados (USD por 1M tokens) -- ADR-10 pede custo estimado
// registrado a cada chamada, não centavo exato. Ajustar conforme tabela de
// preço real vigente quando disponível; modelo desconhecido custa 0 (nunca
// quebra a chamada por falta de preço cadastrado).
const PRICE_PER_MILLION_TOKENS_USD: Record<string, { input: number; output: number }> = {
  "gpt-5.4-nano": { input: 0.05, output: 0.4 },
  "gpt-5.4-mini": { input: 0.25, output: 2 },
  "gpt-5.4": { input: 2.5, output: 10 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
};

export function estimateCostUsd(model: string, usage: JsonCompletionUsage): number {
  const price = PRICE_PER_MILLION_TOKENS_USD[model];
  if (!price) return 0;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}
