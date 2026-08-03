import type { StageInput } from "./types.js";

// ADR-10: custo checado ANTES de cada chamada à OpenAI, nunca só registrado
// depois. Lê o orçamento configurado na aba Custos (edital_costs) e o
// consumido até agora (soma de cost_entries) -- os mesmos números que a
// própria tela de Custos mostra, então o comportamento nunca surpreende
// quem já olhou o painel. budget_total/limit_per_application em 0 (ou
// ausente) significa "sem limite configurado ainda", mesma convenção já
// usada no front-end (useEditalCosts) -- nunca bloqueia por engano só
// porque a avaliadora ainda não configurou nada.
export async function assertBudgetAvailable(input: StageInput, stage: string): Promise<void> {
  const status = await input.internalApi.getCostStatus({
    editalId: input.editalId,
    proponentId: input.applicationId,
  });

  if (!status.blockOnExceed) return;

  if (status.budgetTotal > 0 && status.editalConsumed >= status.budgetTotal) {
    throw new Error(
      `Orçamento do edital excedido (R$ ${status.editalConsumed.toFixed(2)} de R$ ${status.budgetTotal.toFixed(2)}) -- bloqueio automático ativado antes da etapa "${stage}". Ajuste o orçamento na aba Custos ou desative o bloqueio automático pra continuar.`,
    );
  }
  if (status.limitPerApplication > 0 && status.applicationConsumed >= status.limitPerApplication) {
    throw new Error(
      `Limite de custo por proponente excedido (R$ ${status.applicationConsumed.toFixed(2)} de R$ ${status.limitPerApplication.toFixed(2)}) -- bloqueio automático ativado antes da etapa "${stage}". Ajuste o limite na aba Custos ou desative o bloqueio automático pra continuar.`,
    );
  }
}
