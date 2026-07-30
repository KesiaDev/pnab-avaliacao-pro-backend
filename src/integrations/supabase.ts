import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../shared/env.js";

// Cliente escopado ao access_token do usuário — respeita RLS. É o único
// cliente Supabase que este backend usa: não existe service_role disponível
// (Lovable Cloud não expõe essa chave nem a senha do Postgres). Escritas
// privilegiadas passam pelo endpoint interno HMAC do app web em vez de
// falar com o Postgres direto — ver integrations/internal-api.ts.
export function createUserScopedClient(
  env: Pick<Env, "SUPABASE_URL" | "SUPABASE_ANON_KEY">,
  accessToken: string,
): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
