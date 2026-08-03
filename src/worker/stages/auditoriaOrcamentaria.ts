import type { StageInput, StageOutput } from "./types.js";
import { loadEnv } from "../../shared/env.js";
import { createOpenAIClient, embedTexts, completeJSON, estimateCostUsd } from "../../integrations/openai.js";
import type { EvidenceInput, FlagInput, MatchedChunk } from "../../integrations/internal-api.js";
import { assertBudgetAvailable } from "./budgetGuard.js";

const AGENT_NAME = "auditoria_orcamentaria";
const MATCH_COUNT = 20;
// Tolerância de arredondamento (centavos) -- planilhas às vezes trazem
// valores com 1-2 centavos de diferença por arredondamento legítimo, isso
// não deve virar divergência.
const TOLERANCIA_CENTAVOS = 0.02;

interface BudgetLineItem {
  chunkIndex: number;
  descricaoItem: string;
  valorUnitario: number | null;
  quantidade: number | null;
  valorTotalInformado: number | null;
  possivelmenteDesproporcional: boolean;
  motivoDesproporcao: string | null;
}

interface ExtractedBudget {
  itens: BudgetLineItem[];
  valorTotalDoProjetoInformado: number | null;
  valorTotalDoProjetoChunkIndex: number | null;
}

const SYSTEM_PROMPT = `Você é um extrator de fatos auxiliar da Comissão de Avaliação e Seleção (CAS) de um edital de fomento cultural (PNAB) da Secretaria Municipal da Cultura de Caxias do Sul. Sua função é EXTRAIR, linha por linha, os itens da planilha orçamentária apresentada pelo proponente (colunas tipicamente: "Descrição do item", "Justificativa", "Unidade de medida", "Valor unitário (R$)", "Qtd.", "Valor total (R$)") -- você NUNCA calcula nem julga, só transcreve os números exatamente como estão escritos.

Para cada linha da planilha, extraia: a descrição do item, o valor unitário (R$), a quantidade, e o valor total que a PRÓPRIA PLANILHA informa pra aquela linha -- copie o número exatamente como está escrito, mesmo que pareça matematicamente errado (não calcule valor unitário × quantidade você mesmo; a validação é feita depois, fora desta extração).

Também extraia o "VALOR TOTAL DO PROJETO" indicado ao final da planilha, se houver.

Além disso, aponte -- só pelo olhar comparativo DENTRO da própria planilha, nunca por referência externa -- se algum item tem valor unitário muito acima dos demais itens de escopo/natureza semelhante no mesmo orçamento (ex: dois profissionais com função parecida, mas valores muito diferentes sem justificativa proporcional). Marque "possivelmenteDesproporcional": true e explique o motivo comparativo. Nunca afirme que um valor está "acima do preço de mercado" ou cite qualquer tabela/referência de preço -- você não tem acesso a nenhuma base de preços externa, só pode comparar itens dentro da mesma planilha, e mesmo assim como possibilidade a ser checada por um humano, nunca como fato.

Regras:
- Baseie-se EXCLUSIVAMENTE nos trechos fornecidos, numerados entre colchetes. Se os trechos não contiverem uma planilha orçamentária, devolva "itens": [].
- Nunca invente valores que não estejam explicitamente escritos -- campo ausente ou ilegível vira null.
- Cite o número do trecho ([N]) de onde tirou cada linha, em "chunkIndex".

Responda em JSON estrito, exatamente neste formato:
{"itens": [{"chunkIndex": number, "descricaoItem": string, "valorUnitario": number|null, "quantidade": number|null, "valorTotalInformado": number|null, "possivelmenteDesproporcional": boolean, "motivoDesproporcao": string|null}], "valorTotalDoProjetoInformado": number|null, "valorTotalDoProjetoChunkIndex": number|null}`;

function flagFileRef(chunkIndex: number | null, chunks: MatchedChunk[]): { fileId?: string; pagina?: number } {
  if (chunkIndex === null) return {};
  const chunk = chunks[chunkIndex - 1];
  if (!chunk) return {};
  return { fileId: chunk.fileId, pagina: chunk.paginaInicial };
}

function formatBRL(value: number): string {
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function runAuditoriaOrcamentariaStage(input: StageInput): Promise<StageOutput> {
  await assertBudgetAvailable(input, AGENT_NAME);

  const env = loadEnv();
  const client = createOpenAIClient(env);

  const queryText =
    "Planilha orçamentária. Descrição do item, justificativa, unidade de medida, valor unitário, quantidade, valor total. Valor total do projeto.";
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

  const { result: budget, usage } = await completeJSON<ExtractedBudget>(
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

  const flags: FlagInput[] = [];
  const evidences: EvidenceInput[] = [];
  let somaValoresTotais = 0;
  let algumItemComValorTotal = false;

  for (const item of budget.itens ?? []) {
    const ref = flagFileRef(item.chunkIndex, chunks);

    if (item.valorTotalInformado !== null) {
      somaValoresTotais += item.valorTotalInformado;
      algumItemComValorTotal = true;
    }

    // Divergência aritmética -- 100% determinístico, nunca decidido pela IA
    // (ADR-8): só compara os três números já extraídos.
    if (item.valorUnitario !== null && item.quantidade !== null && item.valorTotalInformado !== null) {
      const esperado = item.valorUnitario * item.quantidade;
      const diferenca = Math.abs(esperado - item.valorTotalInformado);
      if (diferenca > TOLERANCIA_CENTAVOS) {
        const descricao = `Item "${item.descricaoItem}": valor unitário R$ ${formatBRL(item.valorUnitario)} × quantidade ${item.quantidade} deveria totalizar R$ ${formatBRL(esperado)}, mas a planilha indica R$ ${formatBRL(item.valorTotalInformado)} -- divergência de R$ ${formatBRL(diferenca)}.`;
        flags.push({ tipo: "divergencia_documental", descricao, criadoPorAgente: AGENT_NAME, ...ref });
        evidences.push({
          criterion: "D",
          fileId: ref.fileId ?? null,
          paginaInicial: ref.pagina ?? null,
          paginaFinal: ref.pagina ?? null,
          descricaoFactual: descricao,
          trechoRelevante: null,
          robustez: "alta",
          criadoPorAgente: AGENT_NAME,
        });
      }
    }

    if (item.possivelmenteDesproporcional) {
      const descricao = `Item "${item.descricaoItem}" pode estar desproporcional em relação aos demais itens da planilha: ${item.motivoDesproporcao ?? "sem detalhe adicional"}. Verificação preliminar por comparação interna à própria planilha -- não representa consulta a preços de mercado.`;
      flags.push({ tipo: "outro", descricao, criadoPorAgente: AGENT_NAME, ...ref });
      evidences.push({
        criterion: "D",
        fileId: ref.fileId ?? null,
        paginaInicial: ref.pagina ?? null,
        paginaFinal: ref.pagina ?? null,
        descricaoFactual: descricao,
        trechoRelevante: null,
        robustez: "media",
        criadoPorAgente: AGENT_NAME,
      });
    }
  }

  // Soma dos itens vs. valor total do projeto -- sinalizado mesmo se o
  // total bater "por coincidência" com o que foi solicitado, porque a
  // avaliadora quer a divergência registrada de qualquer forma.
  if (algumItemComValorTotal && budget.valorTotalDoProjetoInformado !== null) {
    const diferenca = Math.abs(somaValoresTotais - budget.valorTotalDoProjetoInformado);
    if (diferenca > TOLERANCIA_CENTAVOS) {
      const ref = flagFileRef(budget.valorTotalDoProjetoChunkIndex, chunks);
      const descricao = `A soma dos valores totais dos itens da planilha (R$ ${formatBRL(somaValoresTotais)}) não bate com o "Valor total do projeto" informado (R$ ${formatBRL(budget.valorTotalDoProjetoInformado)}) -- divergência de R$ ${formatBRL(diferenca)}.`;
      flags.push({ tipo: "divergencia_documental", descricao, criadoPorAgente: AGENT_NAME, ...ref });
      evidences.push({
        criterion: "D",
        fileId: ref.fileId ?? null,
        paginaInicial: ref.pagina ?? null,
        paginaFinal: ref.pagina ?? null,
        descricaoFactual: descricao,
        trechoRelevante: null,
        robustez: "alta",
        criadoPorAgente: AGENT_NAME,
      });
    }
  }

  for (const flag of flags) {
    await input.internalApi
      .saveFlag({ proponentId: input.applicationId, flag })
      .catch((err) => input.logger.warn({ err }, "save_flag_failed"));
  }
  if (evidences.length > 0) {
    await input.internalApi.saveEvidence({ proponentId: input.applicationId, evidences });
  }

  input.logger.info(
    { itensExtraidos: budget.itens?.length ?? 0, divergenciasEncontradas: flags.length },
    "auditoria_orcamentaria_completed",
  );

  return {
    ok: true,
    details: { itens: budget.itens?.length ?? 0, divergencias: flags.length },
  };
}
