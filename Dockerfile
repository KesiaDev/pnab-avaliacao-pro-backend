# Sem pasta migrations/ nesta imagem de propósito: o schema (Postgres do
# Supabase) é gerenciado pelo repo web (pnabavaliacaopro/supabase/migrations),
# não por este backend -- ver REVISÃO no plano sobre o Lovable Cloud não
# expor service_role/senha do banco pra este serviço.
#
# Poppler (pdfinfo/pdftotext/pdftoppm) entra desde já, mesmo o pipeline de
# PDF só ligando na Fase 6 — evita reconstruir a imagem base depois.
FROM node:20-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# O comando real (API, Worker ou Cron Drive) é definido pelo "startCommand"
# de cada serviço no railway.json -- esta imagem é compartilhada pelos três.
CMD ["node", "dist/api/index.js"]
