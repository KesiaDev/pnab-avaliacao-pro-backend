-- Fundação multitenant (ADR-4): organizations -> workspaces -> workspace_members,
-- mais a fundação de execução (processing_jobs/processing_stages/stage_attempts)
-- pra provar o padrão de fila idempotente (ADR-2) já nesta fase. RLS desde o
-- commit 1, não esperando a Fase 4 (ver Riscos no plano).

create extension if not exists pgcrypto;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create type public.workspace_role as enum ('owner', 'admin', 'evaluator', 'reviewer', 'viewer');

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.workspace_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

alter table public.organizations enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;

-- security definer pra poder ser usada dentro das próprias policies de
-- workspaces/organizations sem recursão de RLS.
create or replace function public.is_workspace_member(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = auth.uid()
  );
$$;

create policy "members read own workspace" on public.workspaces for select
  using (public.is_workspace_member(id));

create policy "members read own organization" on public.organizations for select
  using (exists (
    select 1 from public.workspaces w
    where w.organization_id = organizations.id and public.is_workspace_member(w.id)
  ));

create policy "members read own membership rows" on public.workspace_members for select
  using (user_id = auth.uid());

revoke all on public.organizations, public.workspaces, public.workspace_members from anon;
grant select on public.organizations, public.workspaces, public.workspace_members to authenticated;

-- Fundação de execução (Fase 2/3 deste plano). application_id ainda é texto
-- opaco, sem FK -- a tabela applications só nasce na Fase 5; o job desta fase
-- é só provar o padrão de fila, não modelar candidatura de verdade.
create table public.processing_jobs (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  application_id text not null,
  status text not null default 'queued' check (status in ('queued', 'em_andamento', 'concluido', 'erro')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.processing_stages (
  id uuid primary key default gen_random_uuid(),
  processing_job_id uuid not null references public.processing_jobs(id) on delete cascade,
  stage_name text not null,
  status text not null default 'pendente' check (status in ('pendente', 'em_andamento', 'concluido', 'erro')),
  created_at timestamptz not null default now()
);

create table public.stage_attempts (
  id uuid primary key,
  processing_job_id uuid not null references public.processing_jobs(id) on delete cascade,
  stage_name text not null,
  attempt_number integer not null default 1,
  input_hash text not null,
  status text not null default 'em_andamento' check (status in ('em_andamento', 'concluido', 'erro')),
  output jsonb,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index stage_attempts_job_stage_idx on public.stage_attempts (processing_job_id, stage_name);

alter table public.processing_jobs enable row level security;
alter table public.processing_stages enable row level security;
alter table public.stage_attempts enable row level security;

create policy "members read jobs of own workspace" on public.processing_jobs for select
  using (public.is_workspace_member(workspace_id));

create policy "members read stages of own workspace jobs" on public.processing_stages for select
  using (exists (
    select 1 from public.processing_jobs j
    where j.id = processing_stages.processing_job_id and public.is_workspace_member(j.workspace_id)
  ));

create policy "members read attempts of own workspace jobs" on public.stage_attempts for select
  using (exists (
    select 1 from public.processing_jobs j
    where j.id = stage_attempts.processing_job_id and public.is_workspace_member(j.workspace_id)
  ));

-- Só a API/Worker (Service Role) grava nessas 3 tabelas -- mesmo padrão do
-- agent_runs no Edital 119 (nenhuma policy de insert/update/delete pra
-- anon/authenticated).
revoke insert, update, delete on public.processing_jobs, public.processing_stages, public.stage_attempts
  from anon, authenticated;
grant select on public.processing_jobs, public.processing_stages, public.stage_attempts to authenticated;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger processing_jobs_set_updated_at
  before update on public.processing_jobs
  for each row execute function public.set_updated_at();
