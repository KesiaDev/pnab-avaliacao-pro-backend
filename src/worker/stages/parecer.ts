import type { StageInput, StageOutput } from "./types.js";
import { loadEnv } from "../../shared/env.js";
import { createOpenAIClient, completeJSON, estimateCostUsd } from "../../integrations/openai.js";

const AGENT_NAME = "agente_parecer";

interface ParecerResponse {
  parecer: string;
}

const SYSTEM_PROMPT = `Você é redator de pareceres técnicos e escreve na primeira pessoa, na voz da própria avaliadora responsável pela análise de mérito cultural do edital de fomento cultural (PNAB) da Secretaria Municipal da Cultura de Caxias do Sul. Com base nos critérios e notas fornecidos, redija a minuta de parecer individual do projeto como um texto corrido, humano e fluido -- não como um relatório burocrático dividido em seções tituladas.

O parecer deve conter, nesta ordem, mas SEM títulos, subtítulos, numeração de seções ou rótulos como "Delimitação da análise", "Potencialidades:", "Limitações:" ou "(1)", "(2)" etc. -- apenas parágrafos corridos, exceto pelo cabeçalho breve de cada critério descrito abaixo:

1. A frase de abertura obrigatória (ver adiante), como parágrafo isolado.
2. Um parágrafo contextual curto: para quem foi feita a análise (nome do proponente) e o que foi considerado -- que a apreciação se baseou nos elementos documentais vinculados a cada critério.
3. Um parágrafo-síntese descrevendo, em linhas gerais, o que a documentação apresentada comprova (trajetória, natureza do projeto, pontos que se destacam no conjunto do dossiê).
4. Um bloco por critério avaliado (todos os que constarem no resumo, na ordem em que aparecem): um cabeçalho curto só com o nome do critério (ex.: "Critério A"), seguido de um parágrafo corrido no padrão "atribuí N pontos, em um máximo de M. [justificativa em linguagem natural, baseada na justificativa técnica fornecida, mas reescrita em tom fluido]". Nunca liste subitens ou marcadores dentro do parágrafo do critério.
5. Um parágrafo de potencialidades: o que se destaca de forma positiva no dossiê como um todo, em prosa corrida, sem rótulo.
6. Uma frase final isolada, no padrão: "Com base nos critérios avaliados e nas evidências apresentadas, atribuo ao proponente a nota individual de [notaIndividualTotal] pontos."

Não inclua um parágrafo de limitações, ressalvas ou alertas -- esse tipo de observação (dependência de portfólio/autodeclaração, ausência de comprovação, evidência insuficiente, indício de divergência, participação anterior no Ciclo 1 etc.) já está registrado nas justificativas de cada critério, que a avaliadora acessa separadamente; a minuta de parecer não deve repeti-las.

A abertura do parecer deve ser exatamente:
"A avaliação foi realizada com base exclusivamente nas informações e nos documentos apresentados pelo agente cultural no ato da inscrição."

Regras obrigatórias:
- Escreva como um parecer redigido à mão: direto, natural, sem linguagem de relatório automatizado ou excesso de formalismo burocrático.
- Nunca compare nominalmente com outros candidatos.
- Nunca exponha CPF, RG, endereço, telefone, e-mail ou dados bancários, mesmo que apareçam nas justificativas fornecidas.
- Não chame a nota individual de "média final" -- é a soma dos critérios obrigatórios (A-G) mais os pontos bônus (H-I-J).
- Use exatamente o valor de "notaIndividualTotal" fornecido no resumo -- nunca some as notas dos critérios você mesmo.
- Se "zeroInMandatoryCriterion" for verdadeiro, mencione claramente, no parágrafo contextual, que o projeto foi desclassificado por ter recebido nota 0 em um critério obrigatório (item 1.3 do edital).
- Este parecer é um documento técnico definitivo. Nunca mencione, em nenhum parágrafo, processos internos de elaboração: não escreva sobre inteligência artificial, automação, agentes, "pendência de revisão humana", "prévia provisória" ou qualquer termo equivalente.

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
