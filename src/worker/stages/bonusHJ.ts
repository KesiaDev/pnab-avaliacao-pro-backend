import type { StageInput, StageOutput } from "./types.js";
import { loadEnv } from "../../shared/env.js";
import { createOpenAIClient, embedTexts, completeJSON, estimateCostUsd } from "../../integrations/openai.js";
import type { CriterionScoreInput, EvidenceInput, MatchedChunk } from "../../integrations/internal-api.js";
import { assertBudgetAvailable } from "./budgetGuard.js";

const AGENT_NAME = "bonus_h_j";
const MATCH_COUNT_FACTS = 16;
const MATCH_COUNT_TITLE = 8;
const MATCH_COUNT_CICLO1 = 12;

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
  tituloProjeto: string | null;
  autodeclaracaoCiclo1: "sim" | "nao" | "nao_encontrado";
  autodeclaracaoCiclo1Evidencia: { chunkIndex: number; trecho: string } | null;
}

const SYSTEM_PROMPT = `Você é um extrator de fatos auxiliar da Comissão de Avaliação e Seleção (CAS) de um edital de fomento cultural (PNAB) da Secretaria Municipal da Cultura de Caxias do Sul. Sua função é EXTRAIR fatos objetivos do dossiê pra apoiar o cálculo de pontos bônus -- você NUNCA decide pontuação, só extrai o que está escrito nos trechos numerados fornecidos.

Extraia, com base EXCLUSIVA nos trechos fornecidos:

1. TIPO DE AGENTE CULTURAL: o formulário de inscrição pergunta "Agente cultural é pessoa Física ou pessoa jurídica?" com opções (Pessoa física / Representante de grupo ou coletivo sem CNPJ / Pessoa jurídica MEI / Pessoa jurídica demais enquadramentos). Identifique qual foi marcada. Se não encontrar claramente, responda "indeterminado".

2. BAIRROS DA AÇÃO CULTURAL: identifique todos os bairros ou territórios onde a AÇÃO CULTURAL (não a residência do proponente) vai acontecer, conforme descrito no projeto/cronograma/perfil de público. Se não houver menção clara de bairro/território da ação, deixe a lista vazia -- não invente.

3. AÇÃO AFIRMATIVA:
   - Se pessoa física: procure autodeclaração de "mulher" (cisgênero ou transgênero) ou "pessoa LGBTQIAPN+" nos campos de gênero e identidade do formulário.
   - Se pessoa jurídica ou coletivo/grupo: procure declaração de que a composição é majoritariamente de mulheres ou pessoas LGBTQIAPN+, OU de que o quadro/equipe é majoritariamente composto por pessoas negras, indígenas ou pessoas com deficiência.
   Reporte se encontrou essa autodeclaração explícita e transcreva o trecho.

4. TÍTULO DO PROJETO: procure um campo explícito de título/nome do projeto no formulário de inscrição (ex.: "Título do Projeto", "Nome do Projeto"), normalmente logo no início do formulário, antes da descrição. Transcreva o título exatamente como está escrito. Se não houver um campo de título explícito e claramente identificável, responda null -- nunca crie um título a partir da descrição, dos objetivos ou de qualquer outro conteúdo do projeto.

5. AUTODECLARAÇÃO SOBRE O PNAB CICLO 1: o formulário de inscrição (Google Forms) tem a pergunta de múltipla escolha "O agente cultural teve projeto aprovado no Município de Caxias do Sul com recursos da PNAB – Ciclo 1?", com opções "Sim" e "Não". No texto extraído do PDF, a opção marcada aparece normalmente com um círculo preenchido (●) ou marcador equivalente imediatamente antes dela, enquanto a opção não marcada aparece com um círculo vazio (○) ou sem marcador -- preste atenção nesse símbolo pra saber qual foi selecionada, não presuma pela ordem. Se as duas opções aparecerem sem nenhum indicativo visual de qual foi marcada, responda "nao_encontrado" -- nunca deduza a partir de outras informações do dossiê. Reporte também o número do trecho ([N]) onde encontrou essa pergunta/resposta.

Regras:
- Nunca infira tipo de agente, gênero, raça/etnia ou deficiência a partir de nome, foto ou aparência -- só a partir de autodeclaração explícita em texto.
- Não julgue se um bairro é ou não periférico -- só extraia o NOME do bairro exatamente como está escrito. Essa decisão é feita depois, fora desta extração.
- Se a informação não estiver clara ou não existir no texto, deixe o campo null/vazio/indeterminado/nao_encontrado em vez de adivinhar.

Responda em JSON estrito, exatamente neste formato:
{"tipoProponente": "pessoa_fisica"|"pessoa_juridica_ou_coletivo"|"indeterminado", "tipoProponenteEvidencia": {"chunkIndex": number, "trecho": string} | null, "acoesBairros": [{"bairro": string, "chunkIndex": number, "trecho": string}], "autodeclaracaoAcaoAfirmativa": {"aplicavel": boolean, "descricao": string | null, "chunkIndex": number | null}, "tituloProjeto": string | null, "autodeclaracaoCiclo1": "sim"|"nao"|"nao_encontrado", "autodeclaracaoCiclo1Evidencia": {"chunkIndex": number, "trecho": string} | null}`;

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
  await assertBudgetAvailable(input, AGENT_NAME);

  const env = loadEnv();
  const client = createOpenAIClient(env);

  const { criteria } = await input.internalApi.getEditalCriteria(input.editalId, ["H", "I", "J"]);
  if (criteria.length === 0) {
    throw new Error("Nenhum dos critérios H/I/J encontrado pro edital.");
  }

  // Consultas separadas (não uma única combinada) -- um embedding médio de
  // tópicos tão diferentes (tipo de agente/bairro/ação afirmativa vs.
  // título do projeto) tende a diluir a recuperação do tópico menos
  // dominante, o mesmo problema já corrigido em evaluatorShared.ts.
  const factsQueryText =
    "Tipo de agente cultural pessoa física ou jurídica ou coletivo. Bairro ou território onde a ação cultural será realizada. Autodeclaração de gênero, mulher, pessoa LGBTQIAPN+. Composição racial do quadro societário, pessoas negras, indígenas, pessoa com deficiência.";
  const titleQueryText =
    "Título ou nome do projeto cultural, conforme informado no campo de título do formulário de inscrição.";
  const ciclo1QueryText =
    "O agente cultural teve projeto aprovado no Município de Caxias do Sul com recursos da PNAB – Ciclo 1? Sim Não.";
  const [factsEmbedding, titleEmbedding, ciclo1Embedding] = await embedTexts(client, env.OPENAI_EMBEDDING_MODEL, [
    factsQueryText,
    titleQueryText,
    ciclo1QueryText,
  ]);
  if (!factsEmbedding || !titleEmbedding || !ciclo1Embedding) {
    throw new Error("Falha ao gerar embedding de consulta.");
  }

  const [factsResult, titleResult, ciclo1Result] = await Promise.all([
    input.internalApi.matchDocumentChunks({
      proponentId: input.applicationId,
      queryEmbedding: factsEmbedding,
      matchCount: MATCH_COUNT_FACTS,
    }),
    input.internalApi.matchDocumentChunks({
      proponentId: input.applicationId,
      queryEmbedding: titleEmbedding,
      matchCount: MATCH_COUNT_TITLE,
    }),
    input.internalApi.matchDocumentChunks({
      proponentId: input.applicationId,
      queryEmbedding: ciclo1Embedding,
      matchCount: MATCH_COUNT_CICLO1,
    }),
  ]);
  const chunksById = new Map<string, MatchedChunk>();
  for (const chunk of [...factsResult.chunks, ...titleResult.chunks, ...ciclo1Result.chunks]) {
    if (!chunksById.has(chunk.chunkId)) chunksById.set(chunk.chunkId, chunk);
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
      cachedTokens: usage.cachedTokens,
      outputTokens: usage.outputTokens,
      cost,
    })
    .catch((err) => input.logger.warn({ err }, "cost_entry_save_failed"));

  if (facts.tipoProponente !== "indeterminado") {
    await input.internalApi
      .saveTipoProponente({ proponentId: input.applicationId, tipoProponente: facts.tipoProponente })
      .catch((err) => input.logger.warn({ err }, "save_tipo_proponente_failed"));
  }

  if (facts.tituloProjeto && facts.tituloProjeto.trim().length > 0) {
    await input.internalApi
      .saveProjectTitle({ proponentId: input.applicationId, titulo: facts.tituloProjeto.trim() })
      .catch((err) => input.logger.warn({ err }, "save_project_title_failed"));
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

  // ---------- J: PNAB Ciclo 1 ----------
  // A correspondência por nome contra cycle1_awardees é determinística
  // (código, não IA -- ADR-8), mas sozinha pode falhar quando o proponente
  // está inscrito sob um nome (ex.: associação civil) diferente do nome com
  // que constou na lista de contemplados (ex.: instituição vinculada/nome
  // fantasia do espaço). A autodeclaração do próprio proponente no
  // formulário é o sinal mais direto quando ele afirma "sim" -- soberana
  // sobre a ausência de correspondência de nome. Quando ele afirma "não" mas
  // a lista aponta correspondência, isso é tratado como divergência a
  // verificar, nunca como decisão silenciosa num sentido ou noutro.
  const jMax = maxByCode.get("J") ?? 10;
  const cycle1 = await input.internalApi.checkCycle1Match(input.applicationId);
  const nameMatchFound = cycle1.match !== "sem_correspondencia";

  if (facts.autodeclaracaoCiclo1 === "sim") {
    scores.push({
      criterion: "J",
      proposedScore: 0,
      appliedBand: "autodeclarado",
      justification: nameMatchFound
        ? `O proponente autodeclarou, no formulário de inscrição, já ter sido contemplado no PNAB Ciclo 1 -- também confirmado pela correspondência de nome "${cycle1.awardeeName}" na lista de contemplados do Edital nº 231/2024.`
        : "O proponente autodeclarou, no formulário de inscrição, já ter sido contemplado no PNAB Ciclo 1. Não foi encontrada correspondência de nome na lista de contemplados do Edital nº 231/2024, mas a autodeclaração do próprio proponente é considerada suficiente pra esta pontuação.",
      humanReviewRequired: !nameMatchFound,
    });
    const ev = evidenceFrom(
      "J",
      facts.autodeclaracaoCiclo1Evidencia?.chunkIndex ?? null,
      chunks,
      "Autodeclaração de contemplação anterior no PNAB Ciclo 1 (respondeu Sim no formulário de inscrição).",
      facts.autodeclaracaoCiclo1Evidencia?.trecho ?? null,
    );
    if (ev) evidences.push(ev);
    if (!nameMatchFound) {
      await input.internalApi
        .saveFlag({
          proponentId: input.applicationId,
          flag: {
            tipo: "divergencia_documental",
            descricao:
              "O proponente autodeclarou contemplação anterior no PNAB Ciclo 1, mas o nome não foi encontrado na lista de contemplados do Edital nº 231/2024 -- pode ser variação de nome (ex.: razão social do proponente vs. nome da instituição/espaço vinculado que constou na lista) ou referir-se a outro ciclo/edital. Verificar manualmente.",
            criadoPorAgente: AGENT_NAME,
          },
        })
        .catch((err) => input.logger.warn({ err }, "save_flag_failed"));
    }
  } else if (nameMatchFound) {
    const divergeDaAutodeclaracao = facts.autodeclaracaoCiclo1 === "nao";
    scores.push({
      criterion: "J",
      proposedScore: 0,
      appliedBand: cycle1.match === "exata" ? "correspondência exata" : "correspondência provável",
      justification: `Nome "${cycle1.awardeeName}" encontrado na lista de contemplados do Ciclo 1 (Edital nº 231/2024), correspondência ${cycle1.match === "exata" ? "exata" : "provável"}.${divergeDaAutodeclaracao ? " O proponente autodeclarou NÃO ter sido contemplado anteriormente -- divergência com a lista oficial." : ""}`,
      humanReviewRequired: cycle1.match === "provavel" || divergeDaAutodeclaracao,
    });
    await input.internalApi
      .saveFlag({
        proponentId: input.applicationId,
        flag: {
          tipo: cycle1.match === "exata" ? "ciclo1_exata" : "ciclo1_provavel",
          descricao: divergeDaAutodeclaracao
            ? `Possível participação anterior no Ciclo 1 (contemplado: "${cycle1.awardeeName}") -- DIVERGE da autodeclaração do proponente, que respondeu não ter sido contemplado. Requer verificação manual.`
            : `Possível participação anterior no Ciclo 1 (contemplado: "${cycle1.awardeeName}").`,
          criadoPorAgente: AGENT_NAME,
        },
      })
      .catch((err) => input.logger.warn({ err }, "save_flag_failed"));
    if (divergeDaAutodeclaracao) {
      const ev = evidenceFrom(
        "J",
        facts.autodeclaracaoCiclo1Evidencia?.chunkIndex ?? null,
        chunks,
        `Autodeclaração de NÃO contemplação anterior no PNAB Ciclo 1 (respondeu Não no formulário), divergente da lista oficial (contemplado: "${cycle1.awardeeName}").`,
        facts.autodeclaracaoCiclo1Evidencia?.trecho ?? null,
      );
      if (ev) evidences.push(ev);
    }
  } else {
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
  }

  await input.internalApi.saveCriterionScores({ proponentId: input.applicationId, scores });
  if (evidences.length > 0) {
    await input.internalApi.saveEvidence({ proponentId: input.applicationId, evidences });
  }

  const anyHumanReview = scores.some((s) => s.humanReviewRequired);
  input.logger.info(
    {
      tipoProponente: facts.tipoProponente,
      autodeclaracaoCiclo1: facts.autodeclaracaoCiclo1,
      cycle1: cycle1.match,
      cycle1AwardeeName: cycle1.awardeeName,
      jScore: scores.find((s) => s.criterion === "J")?.proposedScore,
      anyHumanReview,
    },
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
