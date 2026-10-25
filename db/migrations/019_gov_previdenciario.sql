-- 019 — revisão previdenciária: o Gov tem a folha, o Reversa Tax tem o motor.
--
-- A folha (eventos do eSocial) entra no Gov como documento; o Gov a envia ao
-- Tax, que devolve as teses apuradas. Aqui ficam o registro da chamada e as
-- teses que voltaram, com a origem (run) de cada uma.
--
-- As teses previdenciárias NÃO se misturam com os candidatos de IRRF
-- (gov_candidates): o benefício é de outro natureza (o empregador, não a
-- receita municipal) e a soma entre elas seria um erro metodológico.
create table if not exists gov_previdenciario_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  municipality_id uuid not null references gov_municipalities(id),
  status varchar(20) not null default 'RUNNING' check (status in ('RUNNING', 'OK', 'ERROR')),
  engine_version varchar(20),
  engine_version_extra varchar(20),
  arquivos int not null default 0,
  teses_count int not null default 0,
  total_cents bigint not null default 0,
  total_no_prazo_cents bigint not null default 0,
  documentos uuid[],
  resultado jsonb,
  erro text,
  requested_by uuid references users(id),
  created_at timestamptz not null default now()
);

create index if not exists gov_previdenciario_runs_org_idx on gov_previdenciario_runs (organization_id, created_at desc);
create index if not exists gov_previdenciario_runs_municipio_idx on gov_previdenciario_runs (municipality_id, created_at desc);

create table if not exists gov_previdenciario_teses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  run_id uuid not null references gov_previdenciario_runs(id) on delete cascade,
  municipality_id uuid not null references gov_municipalities(id),
  tese_id varchar(20) not null,
  nome text,
  base_cents bigint not null default 0,
  base_no_prazo_cents bigint not null default 0,
  valor_cents bigint not null default 0,
  valor_no_prazo_cents bigint not null default 0,
  competencias int not null default 0,
  condicional boolean not null default false,
  status varchar(20) not null default 'DRAFT' check (status in ('DRAFT', 'NEEDS_EVIDENCE', 'UNDER_REVIEW', 'VALIDATED', 'REJECTED', 'ON_HOLD')),
  documento_id uuid references gov_documents(id),
  observacao text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists gov_previdenciario_teses_run_idx on gov_previdenciario_teses (run_id);
create index if not exists gov_previdenciario_teses_municipio_idx on gov_previdenciario_teses (organization_id, municipality_id, updated_at desc);
