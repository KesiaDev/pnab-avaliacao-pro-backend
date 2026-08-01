import type { StageInput, StageOutput } from "./types.js";

// Os arquivos já estão no Storage privado desde a sincronização do Drive
// (Fase 5) -- esta etapa não baixa nada pra si mesma (nada sobrevive pro
// próximo job da fila, ver types.ts), só confirma que o proponente tem pelo
// menos um arquivo e que cada URL assinada realmente responde, pra falhar
// cedo e com mensagem clara em vez de description genérica lá na frente.
export async function runDownloadStage(input: StageInput): Promise<StageOutput> {
  const { files } = await input.internalApi.listProponentFiles(input.applicationId);

  if (files.length === 0) {
    throw new Error("Proponente não tem nenhum arquivo importado do Drive ainda.");
  }

  const failures: string[] = [];
  for (const file of files) {
    const res = await fetch(file.downloadUrl, { method: "HEAD" });
    if (!res.ok) {
      failures.push(`${file.nome} (HTTP ${res.status})`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Arquivo(s) inacessíveis no Storage: ${failures.join(", ")}`);
  }

  input.logger.info({ totalArquivos: files.length }, "download_stage_verified");
  return { ok: true, details: { totalArquivos: files.length } };
}
