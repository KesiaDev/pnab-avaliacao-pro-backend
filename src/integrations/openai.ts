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
