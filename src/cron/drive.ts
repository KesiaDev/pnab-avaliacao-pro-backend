// Stub da Fase 5 (sincronização do Google Drive) — só existe pra o serviço
// Railway "Cron Drive" ter um entrypoint válido desde já. OAuth, allowlist de
// pasta, download e detecção de mudanças entram quando a Fase 5 começar; ver
// ADR-11 no plano (Drive é fonte somente-leitura, cópia nunca é apagada).
import { loadEnv } from "../shared/env.js";
import { createLogger } from "../observability/logger.js";

const env = loadEnv();
const logger = createLogger(env);

logger.info("cron_drive_not_implemented_yet — Fase 5");
process.exit(0);
