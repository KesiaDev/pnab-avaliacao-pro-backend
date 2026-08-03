import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger } from "../src/observability/logger.js";
import type { EditalCriterion, MatchedChunk } from "../src/integrations/internal-api.js";

vi.mock("../src/integrations/openai.js", () => ({
  createOpenAIClient: vi.fn(() => ({ fake: "client" })),
  embedTexts: vi.fn(async (_client: unknown, _model: unknown, texts: string[]) => texts.map(() => [0.1, 0.2])),
  completeJSON: vi.fn(),
  estimateCostUsd: vi.fn(() => 0.001),
}));
vi.mock("../src/shared/env.js", () => ({
  loadEnv: vi.fn(() => ({
    OPENAI_API_KEY: "sk-test",
    OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
    OPENAI_MODEL_EXTRACTION: "gpt-5.4-nano",
  })),
}));

const openai = await import("../src/integrations/openai.js");
const { runBonusHJStage } = await import("../src/worker/stages/bonusHJ.js");

function makeCriteria(): EditalCriterion[] {
  return [
    { code: "H", title: "Bônus territorial", description: "desc H", maximumScore: 5, eliminatory: false, bonus: true },
    { code: "I", title: "Ação afirmativa", description: "desc I", maximumScore: 5, eliminatory: false, bonus: true },
    { code: "J", title: "PNAB Ciclo 1", description: "desc J", maximumScore: 10, eliminatory: false, bonus: true },
  ];
}

function makeChunks(): MatchedChunk[] {
  return [
    { chunkId: "c1", fileId: "file-1", fileNome: "Formulário de Inscrição.pdf", paginaInicial: 1, paginaFinal: 1, texto: "texto 1", similarity: 0.9 },
    { chunkId: "c2", fileId: "file-2", fileNome: "Currículo.pdf", paginaInicial: 2, paginaFinal: 2, texto: "texto 2", similarity: 0.8 },
  ];
}

function baseInternalApi() {
  return {
    getCostStatus: vi.fn(async () => ({
      budgetTotal: 0,
      editalConsumed: 0,
      limitPerApplication: 0,
      applicationConsumed: 0,
      blockOnExceed: true,
    })),
    getEditalCriteria: vi.fn(async () => ({ criteria: makeCriteria() })),
    matchDocumentChunks: vi.fn(async () => ({ chunks: makeChunks() })),
    saveCostEntry: vi.fn(async () => ({ ok: true as const })),
    saveTipoProponente: vi.fn(async () => ({ ok: true as const })),
    saveProjectTitle: vi.fn(async () => ({ ok: true as const })),
    saveCriterionScores: vi.fn(async () => ({ ok: true as const, saved: 0 })),
    saveEvidence: vi.fn(async () => ({ ok: true as const, saved: 0 })),
    saveFlag: vi.fn(async () => ({ ok: true as const })),
    checkCycle1Match: vi.fn(async () => ({
      match: "sem_correspondencia" as const,
      awardeeName: null,
      totalAwardeesOnFile: 12,
    })),
  };
}

function makeInput(overrides: Partial<ReturnType<typeof baseInternalApi>> = {}) {
  const internalApi = { ...baseInternalApi(), ...overrides };
  return {
    editalId: "edital-1",
    applicationId: "proponent-1",
    internalApi: internalApi as never,
    logger: createLogger({ NODE_ENV: "test" }),
  };
}

function mockFacts(facts: Record<string, unknown>) {
  vi.mocked(openai.completeJSON).mockResolvedValue({
    result: facts as never,
    usage: { inputTokens: 10, outputTokens: 10 },
  });
}

describe("runBonusHJStage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("bloqueia a etapa quando o limite de custo por proponente já foi excedido (ADR-10)", async () => {
    const input = makeInput({
      getCostStatus: vi.fn(async () => ({
        budgetTotal: 0,
        editalConsumed: 0,
        limitPerApplication: 1,
        applicationConsumed: 1.5,
        blockOnExceed: true,
      })),
    });
    await expect(runBonusHJStage(input)).rejects.toThrow("Limite de custo por proponente excedido");
    expect(input.internalApi.getEditalCriteria).not.toHaveBeenCalled();
  });

  it("H=5 quando o bairro extraído não está na lista de excluídos", async () => {
    mockFacts({
      tipoProponente: "pessoa_fisica",
      tipoProponenteEvidencia: null,
      acoesBairros: [{ bairro: "Bairro Fátima", chunkIndex: 1, trecho: "ação no Bairro Fátima" }],
      autodeclaracaoAcaoAfirmativa: { aplicavel: false, descricao: null, chunkIndex: null },
    });
    const input = makeInput();

    await runBonusHJStage(input);

    expect(input.internalApi.saveCriterionScores).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      scores: expect.arrayContaining([
        expect.objectContaining({ criterion: "H", proposedScore: 5, humanReviewRequired: false }),
      ]),
    });
  });

  it("H=0 quando o único bairro extraído está na lista oficial de excluídos (case/acento-insensível)", async () => {
    mockFacts({
      tipoProponente: "pessoa_fisica",
      tipoProponenteEvidencia: null,
      acoesBairros: [{ bairro: "São Pelegrino", chunkIndex: 1, trecho: "ação no São Pelegrino" }],
      autodeclaracaoAcaoAfirmativa: { aplicavel: false, descricao: null, chunkIndex: null },
    });
    const input = makeInput();

    await runBonusHJStage(input);

    expect(input.internalApi.saveCriterionScores).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      scores: expect.arrayContaining([
        expect.objectContaining({ criterion: "H", proposedScore: 0 }),
      ]),
    });
  });

  it("H=0 com revisão humana quando nenhum bairro é identificado", async () => {
    mockFacts({
      tipoProponente: "pessoa_fisica",
      tipoProponenteEvidencia: null,
      acoesBairros: [],
      autodeclaracaoAcaoAfirmativa: { aplicavel: false, descricao: null, chunkIndex: null },
    });
    const input = makeInput();

    await runBonusHJStage(input);

    expect(input.internalApi.saveCriterionScores).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      scores: expect.arrayContaining([
        expect.objectContaining({ criterion: "H", proposedScore: 0, humanReviewRequired: true }),
      ]),
    });
  });

  it("I=0 com revisão humana quando o tipo de proponente é indeterminado", async () => {
    mockFacts({
      tipoProponente: "indeterminado",
      tipoProponenteEvidencia: null,
      acoesBairros: [],
      autodeclaracaoAcaoAfirmativa: { aplicavel: false, descricao: null, chunkIndex: null },
    });
    const input = makeInput();

    await runBonusHJStage(input);

    expect(input.internalApi.saveTipoProponente).not.toHaveBeenCalled();
    expect(input.internalApi.saveCriterionScores).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      scores: expect.arrayContaining([
        expect.objectContaining({ criterion: "I", proposedScore: 0, humanReviewRequired: true }),
      ]),
    });
  });

  it("I=5 e persiste tipo_proponente quando a autodeclaração de ação afirmativa é encontrada", async () => {
    mockFacts({
      tipoProponente: "pessoa_fisica",
      tipoProponenteEvidencia: { chunkIndex: 1, trecho: "pessoa física" },
      acoesBairros: [],
      autodeclaracaoAcaoAfirmativa: { aplicavel: true, descricao: "declarou-se mulher", chunkIndex: 2 },
    });
    const input = makeInput();

    await runBonusHJStage(input);

    expect(input.internalApi.saveTipoProponente).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      tipoProponente: "pessoa_fisica",
    });
    expect(input.internalApi.saveCriterionScores).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      scores: expect.arrayContaining([
        expect.objectContaining({ criterion: "I", proposedScore: 5, humanReviewRequired: false }),
      ]),
    });
  });

  it("J=10 mas com revisão humana quando a lista de contemplados do Ciclo 1 está vazia", async () => {
    mockFacts({
      tipoProponente: "pessoa_fisica",
      tipoProponenteEvidencia: null,
      acoesBairros: [],
      autodeclaracaoAcaoAfirmativa: { aplicavel: false, descricao: null, chunkIndex: null },
    });
    const input = makeInput({
      checkCycle1Match: vi.fn(async () => ({
        match: "sem_correspondencia" as const,
        awardeeName: null,
        totalAwardeesOnFile: 0,
      })),
    });

    await runBonusHJStage(input);

    expect(input.internalApi.saveCriterionScores).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      scores: expect.arrayContaining([
        expect.objectContaining({ criterion: "J", proposedScore: 10, humanReviewRequired: true }),
      ]),
    });
  });

  it("J=0 e cria flag quando há correspondência exata no Ciclo 1", async () => {
    mockFacts({
      tipoProponente: "pessoa_fisica",
      tipoProponenteEvidencia: null,
      acoesBairros: [],
      autodeclaracaoAcaoAfirmativa: { aplicavel: false, descricao: null, chunkIndex: null },
    });
    const input = makeInput({
      checkCycle1Match: vi.fn(async () => ({
        match: "exata" as const,
        awardeeName: "Fulano da Silva",
        totalAwardeesOnFile: 40,
      })),
    });

    await runBonusHJStage(input);

    expect(input.internalApi.saveCriterionScores).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      scores: expect.arrayContaining([
        expect.objectContaining({ criterion: "J", proposedScore: 0, humanReviewRequired: false }),
      ]),
    });
    expect(input.internalApi.saveFlag).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      flag: expect.objectContaining({ tipo: "ciclo1_exata" }),
    });
  });

  it("J=0 quando o proponente autodeclara contemplação anterior, mesmo sem correspondência de nome na lista (caso real: nome do proponente diverge do nome que constou na lista)", async () => {
    mockFacts({
      tipoProponente: "pessoa_juridica_ou_coletivo",
      tipoProponenteEvidencia: null,
      acoesBairros: [],
      autodeclaracaoAcaoAfirmativa: { aplicavel: false, descricao: null, chunkIndex: null },
      autodeclaracaoCiclo1: "sim",
    });
    const input = makeInput({
      checkCycle1Match: vi.fn(async () => ({
        match: "sem_correspondencia" as const,
        awardeeName: null,
        totalAwardeesOnFile: 51,
      })),
    });

    await runBonusHJStage(input);

    expect(input.internalApi.saveCriterionScores).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      scores: expect.arrayContaining([
        expect.objectContaining({ criterion: "J", proposedScore: 0, humanReviewRequired: true }),
      ]),
    });
    expect(input.internalApi.saveFlag).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      flag: expect.objectContaining({ tipo: "divergencia_documental" }),
    });
  });

  it("grava evidência (arquivo/página) pra autodeclaração de contemplação anterior no Ciclo 1, não só a flag", async () => {
    mockFacts({
      tipoProponente: "pessoa_juridica_ou_coletivo",
      tipoProponenteEvidencia: null,
      acoesBairros: [],
      autodeclaracaoAcaoAfirmativa: { aplicavel: false, descricao: null, chunkIndex: null },
      autodeclaracaoCiclo1: "sim",
      autodeclaracaoCiclo1Evidencia: { chunkIndex: 1, trecho: "O agente cultural teve projeto aprovado... Sim" },
    });
    const input = makeInput({
      checkCycle1Match: vi.fn(async () => ({
        match: "sem_correspondencia" as const,
        awardeeName: null,
        totalAwardeesOnFile: 51,
      })),
    });

    await runBonusHJStage(input);

    expect(input.internalApi.saveEvidence).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      evidences: expect.arrayContaining([
        expect.objectContaining({ criterion: "J", fileId: "file-1", paginaInicial: 1 }),
      ]),
    });
  });

  it("J=0 sem revisão humana quando o proponente autodeclara contemplação e a lista também confirma", async () => {
    mockFacts({
      tipoProponente: "pessoa_juridica_ou_coletivo",
      tipoProponenteEvidencia: null,
      acoesBairros: [],
      autodeclaracaoAcaoAfirmativa: { aplicavel: false, descricao: null, chunkIndex: null },
      autodeclaracaoCiclo1: "sim",
    });
    const input = makeInput({
      checkCycle1Match: vi.fn(async () => ({
        match: "exata" as const,
        awardeeName: "Museu dos Capuchinhos do Rio Grande do Sul",
        totalAwardeesOnFile: 51,
      })),
    });

    await runBonusHJStage(input);

    expect(input.internalApi.saveCriterionScores).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      scores: expect.arrayContaining([
        expect.objectContaining({ criterion: "J", proposedScore: 0, humanReviewRequired: false }),
      ]),
    });
  });

  it("sinaliza divergência quando o proponente autodeclara NÃO ter sido contemplado, mas a lista encontra correspondência", async () => {
    mockFacts({
      tipoProponente: "pessoa_juridica_ou_coletivo",
      tipoProponenteEvidencia: null,
      acoesBairros: [],
      autodeclaracaoAcaoAfirmativa: { aplicavel: false, descricao: null, chunkIndex: null },
      autodeclaracaoCiclo1: "nao",
    });
    const input = makeInput({
      checkCycle1Match: vi.fn(async () => ({
        match: "exata" as const,
        awardeeName: "Fulano da Silva",
        totalAwardeesOnFile: 51,
      })),
    });

    await runBonusHJStage(input);

    expect(input.internalApi.saveCriterionScores).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      scores: expect.arrayContaining([
        expect.objectContaining({ criterion: "J", proposedScore: 0, humanReviewRequired: true }),
      ]),
    });
    expect(input.internalApi.saveFlag).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      flag: expect.objectContaining({ tipo: "ciclo1_exata", descricao: expect.stringContaining("DIVERGE") }),
    });
  });

  it("busca chunks separadamente pra fatos, título do projeto e autodeclaração do Ciclo 1, e deduplica", async () => {
    const matchDocumentChunks = vi
      .fn()
      .mockResolvedValueOnce({ chunks: [makeChunks()[0]] })
      .mockResolvedValueOnce({ chunks: makeChunks() })
      .mockResolvedValueOnce({ chunks: [makeChunks()[1]] });
    mockFacts({
      tipoProponente: "pessoa_fisica",
      tipoProponenteEvidencia: null,
      acoesBairros: [],
      autodeclaracaoAcaoAfirmativa: { aplicavel: false, descricao: null, chunkIndex: null },
      tituloProjeto: null,
      autodeclaracaoCiclo1: "nao_encontrado",
    });
    const input = makeInput({ matchDocumentChunks });

    await runBonusHJStage(input);

    expect(matchDocumentChunks).toHaveBeenCalledTimes(3);
  });

  it("salva o título do projeto extraído do formulário de inscrição", async () => {
    mockFacts({
      tipoProponente: "pessoa_fisica",
      tipoProponenteEvidencia: null,
      acoesBairros: [],
      autodeclaracaoAcaoAfirmativa: { aplicavel: false, descricao: null, chunkIndex: null },
      tituloProjeto: "Revista Le Musée - 12ª edição",
    });
    const input = makeInput();

    await runBonusHJStage(input);

    expect(input.internalApi.saveProjectTitle).toHaveBeenCalledWith({
      proponentId: "proponent-1",
      titulo: "Revista Le Musée - 12ª edição",
    });
  });

  it("não salva título quando o agente não encontra um campo explícito", async () => {
    mockFacts({
      tipoProponente: "pessoa_fisica",
      tipoProponenteEvidencia: null,
      acoesBairros: [],
      autodeclaracaoAcaoAfirmativa: { aplicavel: false, descricao: null, chunkIndex: null },
      tituloProjeto: null,
    });
    const input = makeInput();

    await runBonusHJStage(input);

    expect(input.internalApi.saveProjectTitle).not.toHaveBeenCalled();
  });

  it("não falha a etapa quando salvar o título dá erro (best-effort)", async () => {
    mockFacts({
      tipoProponente: "pessoa_fisica",
      tipoProponenteEvidencia: null,
      acoesBairros: [],
      autodeclaracaoAcaoAfirmativa: { aplicavel: false, descricao: null, chunkIndex: null },
      tituloProjeto: "Revista Le Musée",
    });
    const input = makeInput({
      saveProjectTitle: vi.fn(async () => {
        throw new Error("falha de rede");
      }),
    });

    await expect(runBonusHJStage(input)).resolves.toMatchObject({ ok: true });
  });
});
