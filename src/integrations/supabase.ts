import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../shared/env.js";

// Service Role só deve ser usado depois que src/security/jwt.ts + a checagem
// de membership/role/edital/candidatura já confirmaram autorização — nunca
// exposto direto a partir de um JWT não verificado. Ver ADR-4 no plano.
export function createServiceRoleClient(env: Pick<Env, "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY">): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Cliente escopado ao JWT do usuário — respeita RLS, usado só pra confirmar
// membership antes de "subir" para o client Service Role.
export function createUserScopedClient(
  env: Pick<Env, "SUPABASE_URL" | "SUPABASE_ANON_KEY">,
  accessToken: string,
): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
