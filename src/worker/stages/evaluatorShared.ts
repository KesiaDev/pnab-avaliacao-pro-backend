import type { StageInput, StageOutput } from "./types.js";
import { loadEnv } from "../../shared/env.js";
import { createOpenAIClient, embedTexts, completeJSON, estimateCostUsd } from "../../integrations/openai.js";
import type {
  EditalCriterion,
  EvidenceRobustness,
  EvidenceInput,
  CriterionScoreInput,
  MatchedChunk,
} from "../../integrations/internal-api.js";
import { containsUnexpectedScript } from "../../shared/textValidation.js";
import { assertBudgetAvailable } from "./budgetGuard.js";

// Quantos chunks (trechos) trazer por chamada -- cobre os critérios do
// grupo (3-4 letras) sem estourar o contexto/custo (ADR-9: nunca manda o
// dossiê inteiro pra IA, só o que a busca semântica achou relevante).
const MATCH_COUNT = 24;

interface CriterionResultRaw {
  proposedScore: number;
  justification: string;
  humanReviewRequired: boolean;
  evidences: {
    chunkIndex: number;
    descricaoFactual: string;
    trechoRelevante: string | null;
    robustez: EvidenceRobustness;
  }[];
}

interface EvaluatorResponse {
  criteria: Record<string, CriterionResultRaw>;
}

function buildSystemPrompt(criteria: EditalCriterion[]): string {
  const criteriaText = criteria
    .map((c) => `**Critério ${c.code}** (máximo ${c.maximumScore} pontos) — ${c.title}\n${c.description}`)
    .join("\n\n");
  const allCodes = criteria.map((c) => c.code);
  const evidenceShape =
    '[{"chunkIndex": number, "descricaoFactual": string, "trechoRelevante": string|null, "robustez": "alta"|"media"|"declaratoria"}]';
  const exampleEntries = allCodes
    .map(
      (code) =>
        `"${code}": {"proposedScore": number, "justification": string, "humanReviewRequired": boolean, "evidences": ${evidenceShape}}`,
    )
    .join(", ");

  return `Você é um avaliador técnico auxiliar da Comissão de Avaliação e Seleção (CAS) de um edital de fomento cultural (PNAB) da Secretaria Municipal da Cultura de Caxias do Sul. Sua função é APOIAR a avaliadora humana lendo os documentos do dossiê e propondo uma nota fundamentada para cada critério abaixo — a decisão final é sempre da avaliadora humana, nunca sua.

Critérios a avaliar nesta chamada:

${criteriaText}

Regras obrigatórias:
- Baseie-se EXCLUSIVAMENTE nos trechos do dossiê fornecidos abaixo, numerados entre colchetes (ex: [3]). Nunca invente, presuma ou complete informação que não esteja explicitamente nos trechos.
- O formulário de inscrição (campos "Descrição do projeto", "Objetivos do projeto", "Metas" e "Justificativa") é a fonte PRIMÁRIA pra entender do que se trata a proposta -- é onde o proponente narra o projeto. Use-o como base pra avaliar critérios sobre o conteúdo/mérito do projeto (como relevância cultural e integração comunitária), e depois confronte com os demais documentos do dossiê (comprovantes, currículo, portfólio, matérias de imprensa etc.) pra checar se há comprovação suficiente do que foi narrado -- documentos complementares corroboram ou contestam o formulário, não o substituem.
- Cada critério vale de 0 até o máximo indicado. Não há tabela fixa de faixas — julgue proporcionalmente a quão bem o projeto atende à descrição do critério: 0 = não comprovado/não atendido; nota baixa = atendimento fraco ou incipiente; nota intermediária = atendimento consistente; nota próxima do máximo = atendimento forte, evidente e bem fundamentado.
- Os critérios A a G são ELIMINATÓRIOS: nota 0 em qualquer um desclassifica o projeto inteiro. Só dê 0 quando o critério genuinamente não for atendido em nenhum grau — nunca por falta de leitura sua ou por documento que talvez exista em outro arquivo não fornecido aqui.
- Se houver divergência entre documentos, informação insuficiente pra decidir com segurança, ou qualquer situação ambígua, marque "humanReviewRequired": true e explique o motivo na justificativa — não adivinhe.
- OBRIGATÓRIO: a resposta deve conter uma entrada em "criteria" para CADA UM dos critérios pedidos nesta chamada (${allCodes.join(", ")}), sem exceção. Mesmo que os trechos fornecidos pareçam insuficientes pra um critério específico, NUNCA omita a chave -- avalie com o que houver disponível e marque "humanReviewRequired": true com a justificativa explicando a limitação. Uma chave ausente é tratada como falha grave do sistema.
- Nunca infira características pessoais (raça, gênero, deficiência, orientação sexual) a partir de nome, foto ou aparência — só a partir de autodeclaração explícita no texto.
- Cite os trechos usados em "evidences", referenciando pelo número entre colchetes ([1], [2]...). Cada evidência tem "robustez": "alta" (documento formal/comprovante claro), "media" (indício razoável mas não definitivo) ou "declaratoria" (só a palavra do próprio proponente, sem comprovação documental).
- Nunca mencione processos internos (IA, agentes, automação, prompt) na justificativa — escreva como uma análise técnica direta, em português formal.

Responda em JSON estrito, com uma entrada para cada um dos critérios ${allCodes.join(", ")}, exatamente neste formato:
{"criteria": {${exampleEntries}}}`;
}

// A IA cita trechos na justificativa usando o número entre colchetes do
// contexto que recebeu (ex: "[6]") -- mas esse número só existe dentro
// daquela chamada específica (cada grupo de critérios tem sua própria
// numeração, reiniciada do zero) e nunca era resolvido pra nada depois de
// salvo, deixando a avaliadora sem saber a que documento "[6]" se referia.
// Substitui pela referência real (nome do arquivo + página) antes de
// salvar. Números fora do intervalo de chunks (alucinação da IA) ficam
// como estavam, sem quebrar o texto.
function resolveCitations(text: string, chunks: MatchedChunk[]): string {
  return text.replace(/\[(\d+)\]/g, (original, numStr: string) => {
    const chunk = chunks[Number(numStr) - 1];
    if (!chunk) return original;
    const paginas =
      chunk.paginaInicial === chunk.paginaFinal
        ? `pág. ${chunk.paginaInicial}`
        : `págs. ${chunk.paginaInicial}-${chunk.paginaFinal}`;
    return `(${chunk.fileNome}, ${paginas})`;
  });
}

export async function runEvaluatorStage(
  input: StageInput,
  criterionCodes: string[],
  agentName: string,
): Promise<StageOutput> {
  await assertBudgetAvailable(input, agentName);

  const env = loadEnv();
  const client = createOpenAIClient(env);

  const { criteria } = await input.internalApi.getEditalCriteria(input.editalId, criterionCodes);
  if (criteria.length === 0) {
    throw new Error(`Nenhum dos critérios ${criterionCodes.join("/")} encontrado pro edital.`);
  }

  // Busca semântica POR CRITÉRIO, não uma única consulta combinada -- um
  // embedding médio do grupo inteiro é dominado pelos termos do critério de
  // descrição mais longa/genérica, fazendo critérios mais específicos (ex:
  // relevância cultural, integração comunitária) perderem seus trechos mais
  // relevantes entre os top-N resultados. Cada critério busca sua própria
  // fatia e o resultado final é a união deduplicada.
  const perCriterionMatchCount = Math.max(6, Math.ceil(MATCH_COUNT / criteria.length));
  const criteriaQueryTexts = criteria.map((c) => `${c.title}. ${c.description}`);
  const criteriaEmbeddings = await embedTexts(client, env.OPENAI_EMBEDDING_MODEL, criteriaQueryTexts);
  if (criteriaEmbeddings.length !== criteria.length) {
    throw new Error("Falha ao gerar embedding de consulta pra busca semântica.");
  }

  const chunksById = new Map<string, MatchedChunk>();
  for (const embedding of criteriaEmbeddings) {
    const { chunks: matched } = await input.internalApi.matchDocumentChunks({
      proponentId: input.applicationId,
      queryEmbedding: embedding,
      matchCount: perCriterionMatchCount,
    });
    for (const chunk of matched) {
      if (!chunksById.has(chunk.chunkId)) chunksById.set(chunk.chunkId, chunk);
    }
  }
  const chunks = Array.from(chunksById.values());
  if (chunks.length === 0) {
    throw new Error(
      "Nenhum trecho de documento indexado pra este proponente -- rode extracao_textual/fragmentacao/indexacao antes.",
    );
  }

  const contextText = chunks
    .map((c, i) => `[${i + 1}] (arquivo ${c.fileId}, pág. ${c.paginaInicial}-${c.paginaFinal})\n${c.texto}`)
    .join("\n\n---\n\n");

  const systemPrompt = buildSystemPrompt(criteria);
  const userPrompt = `TRECHOS DO DOSSIÊ (numerados, cite pelo número entre colchetes ao referenciar evidência):\n\n${contextText}`;

  const { result, usage } = await completeJSON<EvaluatorResponse>(
    client,
    env.OPENAI_MODEL_EVALUATION,
    systemPrompt,
    userPrompt,
  );

  const cost = estimateCostUsd(env.OPENAI_MODEL_EVALUATION, usage);
  await input.internalApi
    .saveCostEntry({
      editalId: input.editalId,
      proponentId: input.applicationId,
      stage: agentName,
      model: env.OPENAI_MODEL_EVALUATION,
      inputTokens: usage.inputTokens,
      cachedTokens: usage.cachedTokens,
      outputTokens: usage.outputTokens,
      cost,
    })
    .catch((err) => {
      input.logger.warn({ err }, "cost_entry_save_failed");
    });

  const scores: CriterionScoreInput[] = [];
  const evidences: EvidenceInput[] = [];

  for (const criterionDef of criteria) {
    const raw = result.criteria?.[criterionDef.code];
    if (!raw) {
      scores.push({
        criterion: criterionDef.code,
        proposedScore: 0,
        appliedBand: "não avaliado (resposta incompleta do agente)",
        justification: "O agente não retornou avaliação para este critério nesta chamada -- requer revisão manual.",
        humanReviewRequired: true,
      });
      continue;
    }

    // Clamp de segurança: se a IA extrapolar o teto ou mandar fração, o
    // clamp corrige, mas SEMPRE força revisão humana quando muda o valor
    // (nunca aceita silenciosamente uma nota fora do esperado).
    const clamped = Math.max(0, Math.min(criterionDef.maximumScore, Math.round(raw.proposedScore)));
    const justification = resolveCitations(raw.justification, chunks);
    // Defeito raro e estocástico do modelo: às vezes "vaza" um trecho em
    // outro alfabeto no meio do texto. Diferente do parecer (onde o throw
    // força regenerar tudo), aqui um único critério não deve derrubar a
    // etapa inteira -- só força revisão humana pra essa linha específica.
    const humanReviewRequired =
      raw.humanReviewRequired || clamped !== raw.proposedScore || containsUnexpectedScript(justification);

    scores.push({
      criterion: criterionDef.code,
      proposedScore: clamped,
      appliedBand: null,
      justification,
      humanReviewRequired,
    });

    for (const ev of raw.evidences ?? []) {
      const chunk = chunks[ev.chunkIndex - 1];
      evidences.push({
        criterion: criterionDef.code,
        fileId: chunk?.fileId ?? null,
        paginaInicial: chunk?.paginaInicial ?? null,
        paginaFinal: chunk?.paginaFinal ?? null,
        descricaoFactual: ev.descricaoFactual,
        trechoRelevante: ev.trechoRelevante,
        robustez: ev.robustez,
        criadoPorAgente: agentName,
      });
    }
  }

  await input.internalApi.saveCriterionScores({ proponentId: input.applicationId, scores });
  if (evidences.length > 0) {
    await input.internalApi.saveEvidence({ proponentId: input.applicationId, evidences });
  }

  const anyHumanReview = scores.some((s) => s.humanReviewRequired);
  input.logger.info(
    {
      criterios: scores.map((s) => s.criterion),
      evidenceCount: evidences.length,
      anyHumanReview,
    },
    `${agentName}_completed`,
  );

  return {
    ok: true,
    details: { scores: scores.length, evidences: evidences.length, humanReviewRequired: anyHumanReview },
  };
}
