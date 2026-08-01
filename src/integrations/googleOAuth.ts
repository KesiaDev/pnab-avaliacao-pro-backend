import type { Env } from "../shared/env.js";

// Escopo readonly (não drive.file/Picker) -- a usuária cola a URL da pasta
// direto, então precisamos enumerar recursivamente sem depender de seleção
// item a item via Picker. Ver AGENTS.md/README herdados: mesma escolha já
// documentada como aceitável com aviso, pra uma conta Google dedicada.
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export function buildGoogleAuthUrl(
  env: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_REDIRECT_URI">,
  state: string,
): string {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT_URI) {
    throw new Error("GOOGLE_CLIENT_ID/GOOGLE_REDIRECT_URI não configurados.");
  }
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: DRIVE_SCOPE,
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  env: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "GOOGLE_REDIRECT_URI">,
  code: string,
): Promise<GoogleTokenResponse> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
    throw new Error("Credenciais do Google OAuth não configuradas.");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`Falha ao trocar código por token do Google: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<GoogleTokenResponse>;
}

// Renova o access_token de curta duração (~1h) a partir do refresh_token
// persistido (cifrado) na conexão -- chamado pelo Worker antes de cada
// varredura, já que o access_token obtido no callback OAuth nunca é
// guardado.
export async function refreshAccessToken(
  env: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">,
  refreshToken: string,
): Promise<GoogleTokenResponse> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Credenciais do Google OAuth não configuradas.");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Falha ao renovar token do Google: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<GoogleTokenResponse>;
}

export async function fetchGoogleUserEmail(accessToken: string): Promise<string | null> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { email?: string };
  return json.email ?? null;
}

export function extractFolderId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (match?.[1]) return match[1];
  const idParam = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParam?.[1]) return idParam[1];
  return trimmed;
}

// Confirma que o token consegue enumerar a pasta (validação mínima antes de
// persistir a fonte) -- não faz a varredura recursiva completa aqui, isso é
// trabalho do Worker na Fase de sync de verdade.
export async function fetchFolderMetadata(
  accessToken: string,
  folderId: string,
): Promise<{ id: string; name: string } | null> {
  const params = new URLSearchParams({ fields: "id,name,mimeType" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?${params}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { id: string; name: string; mimeType: string };
  if (json.mimeType !== "application/vnd.google-apps.folder") return null;
  return { id: json.id, name: json.name };
}
