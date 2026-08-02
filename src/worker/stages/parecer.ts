import type { StageInput, StageOutput } from "./types.js";
import { loadEnv } from "../../shared/env.js";
import { createOpenAIClient, completeJSON, estimateCostUsd } from "../../integrations/openai.js";

const AGENT_NAME = "agente_parecer";

interface ParecerResponse {
  parecer: string;
}

const SYSTEM_PROMPT = `Você é redator de pareceres técnicos e escreve na primeira pessoa, na voz da própria avaliadora responsável pela análise de mérito cultural do edital de fomento cultural (PNAB) da Secretaria Municipal da Cultura de Caxias do Sul. Com base nos critérios e notas fornecidos, redija a minuta de parecer individual do projeto, seguindo esta estrutura:
(1) delimitação da análise;
(2) síntese da proposta e da trajetória comprovada do agente cultural;
(3) fundamentos de cada critério avaliado, com base nas justificativas fornecidas;
(4) potencialidades identificadas na proposta;
(5) limitações documentais, se houver;
(6) eventuais alertas (evidência ausente, divergência, participação anterior no Ciclo 1);
(7) nota individual final.

A abertura do parecer deve ser exatamente:
"A avaliação foi realizada com base exclusivamente nas informações e nos documentos apresentados pelo agente cultural no ato da inscrição."

Regras obrigatórias:
- Nunca compare nominalmente com outros candidatos.
- Nunca exponha CPF, RG, endereço, telefone, e-mail ou dados bancários, mesmo que apareçam nas justificativas fornecidas.
- Não chame a nota individual de "média final" -- é a soma dos critérios obrigatórios (A-G) mais os pontos bônus (H-I-J).
- Use exatamente o valor de "notaIndividualTotal" fornecido no resumo -- nunca some as notas dos critérios você mesmo.
- Se "zeroInMandatoryCriterion" for verdadeiro, mencione claramente que o projeto foi desclassificado por ter recebido nota 0 em um critério obrigatório (item 1.3 do edital).
- Este parecer é um documento técnico definitivo. Nunca mencione, em nenhuma seção, processos internos de elaboração: não escreva sobre inteligência artificial, automação, agentes, "pendência de revisão humana", "prévia provisória" ou qualquer termo equivalente.

Responda em JSON estrito: {"parecer": string}`;

export async function runParecerStage(input: StageInput): Promise<StageOutput> {
  const env = loadEnv();
  const client = createOpenAIClient(env);

  const [context, { criteria }] = await Promise.all([
    input.internalApi.getEvaluationContext(input.applicationId),
    input.internalApi.getEditalCriteria(input.editalId),
  ]);

  const titleByCode = new Map(criteria.map((c) => [c.code, c.title]));
  const resumo = {
    proponente: context.proponentNome,
    zeroInMandatoryCriterion: context.zeroInMandatoryCriterion,
    criterios: context.criterionScores.map((cs) => ({
      criterio: cs.criterion,
      titulo: titleByCode.get(cs.criterion) ?? cs.criterion,
      max: cs.maxScore,
      notaProposta: cs.proposedScore,
      faixaAplicada: cs.appliedBand,
      justificativa: cs.justification,
      semEvidencia: (context.evidenceCountByCriterion[cs.criterion] ?? 0) === 0,
    })),
    mandatorySubtotal: context.mandatorySubtotal,
    bonusSubtotal: context.bonusSubtotal,
    notaIndividualTotal: context.individualTotal,
  };

  const userPrompt = `RESUMO DA AVALIAÇÃO (JSON):\n\n${JSON.stringify(resumo, null, 2)}`;

  const { result, usage } = await completeJSON<ParecerResponse>(
    client,
    env.OPENAI_MODEL_AUDIT,
    SYSTEM_PROMPT,
    userPrompt,
  );

  const cost = estimateCostUsd(env.OPENAI_MODEL_AUDIT, usage);
  await input.internalApi
    .saveCostEntry({
      editalId: input.editalId,
      proponentId: input.applicationId,
      stage: AGENT_NAME,
      model: env.OPENAI_MODEL_AUDIT,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cost,
    })
    .catch((err) => input.logger.warn({ err }, "cost_entry_save_failed"));

  if (!result.parecer || result.parecer.trim().length === 0) {
    throw new Error("O agente não retornou texto de parecer.");
  }

  const { versao } = await input.internalApi.saveParecer({
    proponentId: input.applicationId,
    texto: result.parecer,
  });

  input.logger.info({ versao }, "parecer_completed");

  return { ok: true, details: { versao } };
}
