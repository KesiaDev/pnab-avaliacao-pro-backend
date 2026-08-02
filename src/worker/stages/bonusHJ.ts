import type { StageInput, StageOutput } from "./types.js";
import { loadEnv } from "../../shared/env.js";
import { createOpenAIClient, embedTexts, completeJSON, estimateCostUsd } from "../../integrations/openai.js";
import type { CriterionScoreInput, EvidenceInput, MatchedChunk } from "../../integrations/internal-api.js";

const AGENT_NAME = "bonus_h_j";
const MATCH_COUNT = 16;

// Item 4.8.1.2 do Edital 120/2026: bairros que NÃO se enquadram como área
// periférica pra fins do bônus territorial (H) -- lista oficial do texto do
// edital, não a extensão não-oficial que existia no agente legado.
const EXCLUDED_NEIGHBORHOODS = [
  "centro",
  "exposicao",
  "sao pelegrino",
  "rio branco",
  "nossa senhora de lourdes",
  "santa catarina",
  "pio x",
  "panazzolo",
];

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

interface ExtractedFacts {
  tipoProponente: "pessoa_fisica" | "pessoa_juridica_ou_coletivo" | "indeterminado";
  tipoProponenteEvidencia: { chunkIndex: number; trecho: string } | null;
  acoesBairros: { bairro: string; chunkIndex: number; trecho: string }[];
  autodeclaracaoAcaoAfirmativa: {
    aplicavel: boolean;
    descricao: string | null;
    chunkIndex: number | null;
  };
}

const SYSTEM_PROMPT = `Você é um extrator de fatos auxiliar da Comissão de Avaliação e Seleção (CAS) de um edital de fomento cultural (PNAB) da Secretaria Municipal da Cultura de Caxias do Sul. Sua função é EXTRAIR fatos objetivos do dossiê pra apoiar o cálculo de pontos bônus -- você NUNCA decide pontuação, só extrai o que está escrito nos trechos numerados fornecidos.

Extraia, com base EXCLUSIVA nos trechos fornecidos:

1. TIPO DE AGENTE CULTURAL: o formulário de inscrição pergunta "Agente cultural é pessoa Física ou pessoa jurídica?" com opções (Pessoa física / Representante de grupo ou coletivo sem CNPJ / Pessoa jurídica MEI / Pessoa jurídica demais enquadramentos). Identifique qual foi marcada. Se não encontrar claramente, responda "indeterminado".

2. BAIRROS DA AÇÃO CULTURAL: identifique todos os bairros ou territórios onde a AÇÃO CULTURAL (não a residência do proponente) vai acontecer, conforme descrito no projeto/cronograma/perfil de público. Se não houver menção clara de bairro/território da ação, deixe a lista vazia -- não invente.

3. AÇÃO AFIRMATIVA:
   - Se pessoa física: procure autodeclaração de "mulher" (cisgênero ou transgênero) ou "pessoa LGBTQIAPN+" nos campos de gênero e identidade do formulário.
   - Se pessoa jurídica ou coletivo/grupo: procure declaração de que a composição é majoritariamente de mulheres ou pessoas LGBTQIAPN+, OU de que o quadro/equipe é majoritariamente composto por pessoas negras, indígenas ou pessoas com deficiência.
   Reporte se encontrou essa autodeclaração explícita e transcreva o trecho.

Regras:
- Nunca infira tipo de agente, gênero, raça/etnia ou deficiência a partir de nome, foto ou aparência -- só a partir de autodeclaração explícita em texto.
- Não julgue se um bairro é ou não periférico -- só extraia o NOME do bairro exatamente como está escrito. Essa decisão é feita depois, fora desta extração.
- Se a informação não estiver clara ou não existir no texto, deixe o campo null/vazio/indeterminado em vez de adivinhar.

Responda em JSON estrito, exatamente neste formato:
{"tipoProponente": "pessoa_fisica"|"pessoa_juridica_ou_coletivo"|"indeterminado", "tipoProponenteEvidencia": {"chunkIndex": number, "trecho": string} | null, "acoesBairros": [{"bairro": string, "chunkIndex": number, "trecho": string}], "autodeclaracaoAcaoAfirmativa": {"aplicavel": boolean, "descricao": string | null, "chunkIndex": number | null}}`;

function evidenceFrom(
  criterion: string,
  chunkIndex: number | null,
  chunks: MatchedChunk[],
  descricao: string,
  trecho: string | null,
): EvidenceInput | null {
  if (chunkIndex === null) return null;
  const chunk = chunks[chunkIndex - 1];
  if (!chunk) return null;
  return {
    criterion,
    fileId: chunk.fileId,
    paginaInicial: chunk.paginaInicial,
    paginaFinal: chunk.paginaFinal,
    descricaoFactual: descricao,
    trechoRelevante: trecho,
    robustez: "media",
    criadoPorAgente: AGENT_NAME,
  };
}

export async function runBonusHJStage(input: StageInput): Promise<StageOutput> {
  const env = loadEnv();
  const client = createOpenAIClient(env);

  const { criteria } = await input.internalApi.getEditalCriteria(input.editalId, ["H", "I", "J"]);
  if (criteria.length === 0) {
    throw new Error("Nenhum dos critérios H/I/J encontrado pro edital.");
  }

  const queryText =
    "Tipo de agente cultural pessoa física ou jurídica ou coletivo. Bairro ou território onde a ação cultural será realizada. Autodeclaração de gênero, mulher, pessoa LGBTQIAPN+. Composição racial do quadro societário, pessoas negras, indígenas, pessoa com deficiência.";
  const [queryEmbedding] = await embedTexts(client, env.OPENAI_EMBEDDING_MODEL, [queryText]);
  if (!queryEmbedding) throw new Error("Falha ao gerar embedding de consulta.");

  const { chunks } = await input.internalApi.matchDocumentChunks({
    proponentId: input.applicationId,
    queryEmbedding,
    matchCount: MATCH_COUNT,
  });
  if (chunks.length === 0) {
    throw new Error(
      "Nenhum trecho de documento indexado pra este proponente -- rode extracao_textual/fragmentacao/indexacao antes.",
    );
  }

  const contextText = chunks
    .map((c, i) => `[${i + 1}] (arquivo ${c.fileId}, pág. ${c.paginaInicial}-${c.paginaFinal})\n${c.texto}`)
    .join("\n\n---\n\n");
  const userPrompt = `TRECHOS DO DOSSIÊ (numerados, cite pelo número entre colchetes):\n\n${contextText}`;

  const { result: facts, usage } = await completeJSON<ExtractedFacts>(
    client,
    env.OPENAI_MODEL_EXTRACTION,
    SYSTEM_PROMPT,
    userPrompt,
  );

  const cost = estimateCostUsd(env.OPENAI_MODEL_EXTRACTION, usage);
  await input.internalApi
    .saveCostEntry({
      editalId: input.editalId,
      proponentId: input.applicationId,
      stage: AGENT_NAME,
      model: env.OPENAI_MODEL_EXTRACTION,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cost,
    })
    .catch((err) => input.logger.warn({ err }, "cost_entry_save_failed"));

  if (facts.tipoProponente !== "indeterminado") {
    await input.internalApi
      .saveTipoProponente({ proponentId: input.applicationId, tipoProponente: facts.tipoProponente })
      .catch((err) => input.logger.warn({ err }, "save_tipo_proponente_failed"));
  }

  const scores: CriterionScoreInput[] = [];
  const evidences: EvidenceInput[] = [];
  const maxByCode = new Map(criteria.map((c) => [c.code, c.maximumScore]));

  // ---------- H: bônus territorial ----------
  const qualifyingBairro = facts.acoesBairros.find(
    (b) => !EXCLUDED_NEIGHBORHOODS.includes(normalize(b.bairro)),
  );
  const hMax = maxByCode.get("H") ?? 5;
  if (qualifyingBairro) {
    scores.push({
      criterion: "H",
      proposedScore: hMax,
      appliedBand: "comprovado",
      justification: `Ação cultural prevista no bairro/território "${qualifyingBairro.bairro}", que não consta na lista de bairros centrais excluídos pelo item 4.8.1.2 do edital.`,
      humanReviewRequired: false,
    });
    const ev = evidenceFrom("H", qualifyingBairro.chunkIndex, chunks, `Ação cultural no bairro/território "${qualifyingBairro.bairro}".`, qualifyingBairro.trecho);
    if (ev) evidences.push(ev);
  } else if (facts.acoesBairros.length > 0) {
    scores.push({
      criterion: "H",
      proposedScore: 0,
      appliedBand: "não comprovado",
      justification: `Bairro(s)/território(s) identificado(s) (${facts.acoesBairros.map((b) => b.bairro).join(", ")}) constam na lista de bairros centrais excluídos pelo item 4.8.1.2 do edital.`,
      humanReviewRequired: false,
    });
  } else {
    scores.push({
      criterion: "H",
      proposedScore: 0,
      appliedBand: "não comprovado",
      justification: "Não foi identificado, nos trechos disponíveis, o bairro ou território onde a ação cultural será realizada.",
      humanReviewRequired: true,
    });
  }

  // ---------- I: ação afirmativa ----------
  const iMax = maxByCode.get("I") ?? 5;
  if (facts.tipoProponente === "indeterminado") {
    scores.push({
      criterion: "I",
      proposedScore: 0,
      appliedBand: "não avaliado",
      justification: "Não foi possível determinar se o agente cultural é pessoa física ou pessoa jurídica/coletivo a partir dos documentos disponíveis, necessário pra aplicar o critério correto de ação afirmativa.",
      humanReviewRequired: true,
    });
  } else if (facts.autodeclaracaoAcaoAfirmativa.aplicavel) {
    scores.push({
      criterion: "I",
      proposedScore: iMax,
      appliedBand: "comprovado",
      justification: facts.autodeclaracaoAcaoAfirmativa.descricao ?? "Autodeclaração de ação afirmativa identificada no formulário de inscrição.",
      humanReviewRequired: false,
    });
    const ev = evidenceFrom(
      "I",
      facts.autodeclaracaoAcaoAfirmativa.chunkIndex,
      chunks,
      facts.autodeclaracaoAcaoAfirmativa.descricao ?? "Autodeclaração de ação afirmativa.",
      null,
    );
    if (ev) evidences.push(ev);
  } else {
    scores.push({
      criterion: "I",
      proposedScore: 0,
      appliedBand: "não comprovado",
      justification: "Não foi identificada autodeclaração de ação afirmativa aplicável ao critério I nos documentos disponíveis.",
      humanReviewRequired: false,
    });
  }

  // ---------- J: PNAB Ciclo 1 (100% determinístico, sem IA) ----------
  const jMax = maxByCode.get("J") ?? 10;
  const cycle1 = await input.internalApi.checkCycle1Match(input.applicationId);
  if (cycle1.match === "sem_correspondencia") {
    const noDataYet = cycle1.totalAwardeesOnFile === 0;
    scores.push({
      criterion: "J",
      proposedScore: jMax,
      appliedBand: "comprovado",
      justification: noDataYet
        ? "Nenhuma correspondência encontrada na lista de contemplados do Ciclo 1 -- ATENÇÃO: a lista de contemplados (Edital nº 231/2024) ainda não foi importada na plataforma, então este resultado não pode ser considerado definitivo."
        : "Nenhuma correspondência encontrada na lista de contemplados do Ciclo 1 (Edital nº 231/2024).",
      humanReviewRequired: noDataYet,
    });
  } else {
    scores.push({
      criterion: "J",
      proposedScore: 0,
      appliedBand: cycle1.match === "exata" ? "correspondência exata" : "correspondência provável",
      justification: `Nome "${cycle1.awardeeName}" encontrado na lista de contemplados do Ciclo 1 (Edital nº 231/2024), correspondência ${cycle1.match === "exata" ? "exata" : "provável"}.`,
      humanReviewRequired: cycle1.match === "provavel",
    });
    await input.internalApi
      .saveFlag({
        proponentId: input.applicationId,
        flag: {
          tipo: cycle1.match === "exata" ? "ciclo1_exata" : "ciclo1_provavel",
          descricao: `Possível participação anterior no Ciclo 1 (contemplado: "${cycle1.awardeeName}").`,
          criadoPorAgente: AGENT_NAME,
        },
      })
      .catch((err) => input.logger.warn({ err }, "save_flag_failed"));
  }

  await input.internalApi.saveCriterionScores({ proponentId: input.applicationId, scores });
  if (evidences.length > 0) {
    await input.internalApi.saveEvidence({ proponentId: input.applicationId, evidences });
  }

  const anyHumanReview = scores.some((s) => s.humanReviewRequired);
  input.logger.info(
    { tipoProponente: facts.tipoProponente, cycle1: cycle1.match, anyHumanReview },
    "bonus_h_j_completed",
  );

  return {
    ok: true,
    details: {
      scores: scores.map((s) => `${s.criterion}=${s.proposedScore}`),
      humanReviewRequired: anyHumanReview,
    },
  };
}
