import { z } from "zod";

// Validado uma única vez no boot de cada processo (api/worker/cron) — falha
// rápido e alto se faltar variável obrigatória, em vez de quebrar em runtime
// no meio de um job.
//
// Sem SUPABASE_SERVICE_ROLE_KEY de propósito: o Lovable Cloud não expõe essa
// chave (nem a senha do Postgres) pra fora do próprio app. A API usa o
// access_token do usuário (RLS); o Worker nunca fala com o Postgres direto —
// chama o endpoint interno HMAC do app web (ver integrations/internal-api.ts).
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  APP_VERSION: z.string().default("0.0.0"),
  FRONTEND_ORIGIN: z.string().default("http://localhost:5173"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_JWT_ISSUER: z.string().min(1),
  SUPABASE_JWKS_URL: z.string().url(),

  // Base do app web (pnabavaliacaopro) — onde vivem os endpoints internos
  // HMAC que o Worker chama pra gravar progresso/resultado de cada etapa.
  INTERNAL_API_BASE_URL: z.string().url(),
  RAILWAY_INTERNAL_SECRET: z.string().min(16),

  REDIS_URL: z.string().min(1),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_PROJECT_ID: z.string().optional(),
  OPENAI_MODEL_EXTRACTION: z.string().default("gpt-5.4-nano"),
  OPENAI_MODEL_EVALUATION: z.string().default("gpt-5.4-mini"),
  OPENAI_MODEL_AUDIT: z.string().default("gpt-5.4-mini"),
  OPENAI_MODEL_ESCALATION: z.string().default("gpt-5.4"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_USE_BATCH: z.coerce.boolean().default(false),
  OPENAI_USE_BACKGROUND_FOR_ESCALATION: z.coerce.boolean().default(true),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),

  DEFAULT_COST_LIMIT_PER_APPLICATION_USD: z.coerce.number().positive().default(5),
  DEFAULT_COST_LIMIT_PER_EDITAL_USD: z.coerce.number().positive().default(500),
  MAX_CONCURRENT_APPLICATIONS: z.coerce.number().int().positive().default(2),
  MAX_CONCURRENT_OPENAI_CALLS: z.coerce.number().int().positive().default(3),
  MAX_STAGE_ATTEMPTS: z.coerce.number().int().positive().default(3),

  STORAGE_BUCKET_ORIGINALS: z.string().default("application-originals"),
  STORAGE_BUCKET_DERIVED: z.string().default("application-derived"),
  STORAGE_BUCKET_EXPORTS: z.string().default("evaluation-exports"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Variáveis de ambiente inválidas:\n${parsed.error.toString()}`);
  }
  cached = parsed.data;
  return cached;
}
