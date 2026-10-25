-- Schema seguro da suite Reversa Gov: mesma estrutura, sem tocar em dados.
-- Diferencas em relacao a db/schema-completo.sql:
--   - os 2 UPDATE (nome do proprietario e kind da organizacao) foram removidos
--   - os 2 DROP CONSTRAINT so rodam se a tabela gov_* estiver vazia
-- Todo o restante e DDL aditivo: create ... if not exists e add column if not exists.
-- Pode colar varias vezes: e idempotente.

-- Schema completo da suite Reversa Gov (ambiente próprio)
-- Plataforma Reversa + módulo IRRF municipal. Migrations 001 a 015, na ordem.
-- Gerado a partir de db/migrations/ — o mesmo conteúdo que o runner aplica no build.
-- ===== 001_platform.sql =====
-- Reversa Tax — esquema de referência PostgreSQL
-- Versão 0.1 — validar nomes, tipos e convenções contra o banco atual.
-- Não executar diretamente em produção sem revisão e migration versionada.

create extension if not exists pgcrypto;

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name varchar(180) not null,
  status varchar(30) not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_status_ck check (status in ('active', 'suspended', 'archived'))
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email varchar(320) not null,
  email_normalized varchar(320) not null,
  name varchar(180) not null,
  password_hash text not null,
  status varchar(30) not null default 'active',
  session_version integer not null default 0,
  email_verified_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_status_ck check (status in ('active', 'blocked', 'pending', 'archived'))
);

create unique index if not exists users_email_normalized_uq
  on users (email_normalized);

create table if not exists organization_members (
  organization_id uuid not null references organizations(id),
  user_id uuid not null references users(id),
  role varchar(40) not null,
  status varchar(30) not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id),
  constraint organization_members_role_ck check (role in ('owner', 'admin', 'analyst', 'viewer', 'support')),
  constraint organization_members_status_ck check (status in ('active', 'invited', 'suspended'))
);

create table if not exists password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  token_hash bytea not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  requested_ip_hash bytea,
  user_agent_hash bytea,
  created_at timestamptz not null default now()
);

create unique index if not exists password_reset_tokens_hash_uq
  on password_reset_tokens (token_hash);

create index if not exists password_reset_tokens_user_active_idx
  on password_reset_tokens (user_id, expires_at)
  where used_at is null;

create table if not exists auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  session_hash bytea not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create unique index if not exists auth_sessions_hash_uq
  on auth_sessions (session_hash);

create index if not exists auth_sessions_user_active_idx
  on auth_sessions (user_id, expires_at)
  where revoked_at is null;

create table if not exists tax_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  owner_user_id uuid references users(id),
  title varchar(240) not null,
  status varchar(40) not null default 'draft',
  estimated_value numeric(18,2),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_cases_status_ck check (status in ('draft', 'under_review', 'qualified', 'in_progress', 'completed', 'archived'))
);

create index if not exists tax_cases_org_status_updated_idx
  on tax_cases (organization_id, status, updated_at desc);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  tax_case_id uuid not null references tax_cases(id),
  storage_key text not null,
  original_name varchar(255) not null,
  mime_type varchar(120) not null,
  size_bytes bigint not null,
  checksum_sha256 varchar(64),
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists documents_case_idx
  on documents (tax_case_id, created_at desc)
  where deleted_at is null;

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id),
  actor_user_id uuid references users(id),
  event_type varchar(120) not null,
  request_id varchar(120),
  entity_type varchar(80),
  entity_id uuid,
  outcome varchar(30) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_events_outcome_ck check (outcome in ('success', 'failure', 'denied'))
);

create index if not exists audit_events_org_created_idx
  on audit_events (organization_id, created_at desc);

create index if not exists audit_events_type_created_idx
  on audit_events (event_type, created_at desc);

-- Recomendação de implementação:
-- 1) aplicar em migration transacional quando suportado;
-- 2) validar índices e locks com volume representativo;
-- 3) adicionar política de retenção e RLS somente após ADR aprovado;
-- 4) nunca persistir senha, token bruto ou URL completa do reset.


-- Reversa Tax — extensão do domínio tributário
-- Executar somente como migration versionada após revisão do schema de produção.
-- Depende das tabelas organizations, users, tax_cases e documents do initial-schema.sql.

create table if not exists taxpayers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  legal_name varchar(240) not null,
  cnpj varchar(14) not null,
  cnpj_normalized varchar(14) not null,
  tax_regime varchar(50),
  regime_confirmed_at timestamptz,
  status varchar(30) not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint taxpayers_status_ck check (status in ('active', 'suspended', 'archived'))
);

create unique index if not exists taxpayers_org_cnpj_uq
  on taxpayers (organization_id, cnpj_normalized);

create table if not exists tax_rule_versions (
  id uuid primary key default gen_random_uuid(),
  rule_key varchar(160) not null,
  version varchar(40) not null,
  status varchar(30) not null default 'draft',
  legal_effective_from date,
  legal_effective_to date,
  operational_effective_to date,
  source_refs jsonb not null default '[]'::jsonb,
  definition jsonb not null default '{}'::jsonb,
  approved_by uuid references users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint tax_rule_versions_status_ck check (status in ('draft', 'active', 'retired', 'superseded')),
  unique (rule_key, version)
);

create index if not exists tax_rule_versions_active_idx
  on tax_rule_versions (rule_key, status, legal_effective_from);

create table if not exists tax_imports (
  id uuid primary key default gen_random_uuid(),
  tax_case_id uuid not null references tax_cases(id),
  taxpayer_id uuid not null references taxpayers(id),
  document_id uuid references documents(id),
  source_type varchar(40) not null,
  period_start date not null,
  period_end date not null,
  cnpj varchar(14) not null,
  file_sha256 varchar(64) not null,
  parser_version varchar(40) not null,
  status varchar(30) not null default 'received',
  parser_summary jsonb not null default '{}'::jsonb,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_imports_source_type_ck check (source_type in ('efd_contribuicoes', 'ecf', 'nfe', 'contract', 'receipt', 'other')),
  constraint tax_imports_status_ck check (status in ('received', 'processing', 'processed', 'failed', 'superseded'))
);

create unique index if not exists tax_imports_file_uq
  on tax_imports (tax_case_id, file_sha256);

create index if not exists tax_imports_taxpayer_period_idx
  on tax_imports (taxpayer_id, period_start, period_end, status);

create table if not exists tax_analyses (
  id uuid primary key default gen_random_uuid(),
  tax_case_id uuid not null references tax_cases(id),
  taxpayer_id uuid not null references taxpayers(id),
  tax_rule_version_id uuid not null references tax_rule_versions(id),
  period_start date not null,
  period_end date not null,
  engine_version varchar(40) not null,
  status varchar(40) not null default 'candidate',
  review_status varchar(30) not null default 'pending',
  result_summary jsonb not null default '{}'::jsonb,
  assumptions jsonb not null default '[]'::jsonb,
  calculated_at timestamptz,
  created_by uuid not null references users(id),
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_analyses_status_ck check (status in ('candidate', 'potential_to_validate', 'recoverable_pending_approval', 'recoverable_approved', 'risk_to_regularize', 'not_applicable', 'monitoring', 'superseded')),
  constraint tax_analyses_review_ck check (review_status in ('pending', 'in_review', 'approved', 'rejected'))
);

create index if not exists tax_analyses_case_status_idx
  on tax_analyses (tax_case_id, status, updated_at desc);

create table if not exists tax_findings (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references tax_analyses(id),
  import_id uuid references tax_imports(id),
  source_line integer,
  document_ref varchar(120),
  item_ref varchar(120),
  cst_pis varchar(10),
  cst_cofins varchar(10),
  cfop varchar(10),
  base_pis numeric(20,2) not null default 0,
  base_cofins numeric(20,2) not null default 0,
  rate_pis numeric(10,6),
  rate_cofins numeric(10,6),
  amount_pis numeric(20,2) not null default 0,
  amount_cofins numeric(20,2) not null default 0,
  classification varchar(40) not null,
  reason text not null,
  formula jsonb not null default '{}'::jsonb,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint tax_findings_classification_ck check (classification in ('candidate', 'potential_to_validate', 'recoverable_pending_approval', 'recoverable_approved', 'risk_to_regularize', 'not_applicable', 'monitoring'))
);

create index if not exists tax_findings_analysis_idx
  on tax_findings (analysis_id, classification, created_at);

create table if not exists tax_evidence_links (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references tax_findings(id),
  document_id uuid references documents(id),
  evidence_type varchar(60) not null,
  requirement text not null,
  status varchar(30) not null default 'missing',
  notes text,
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint tax_evidence_links_status_ck check (status in ('missing', 'received', 'accepted', 'rejected', 'not_applicable'))
);

create index if not exists tax_evidence_finding_status_idx
  on tax_evidence_links (finding_id, status);

create table if not exists tax_review_events (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references tax_analyses(id),
  actor_user_id uuid not null references users(id),
  from_status varchar(40),
  to_status varchar(40) not null,
  decision text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tax_review_events_analysis_idx
  on tax_review_events (analysis_id, created_at desc);

create table if not exists notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id),
  user_id uuid references users(id),
  template_key varchar(100) not null,
  provider varchar(50) not null,
  idempotency_key varchar(160) not null,
  provider_message_id varchar(240),
  status varchar(30) not null default 'queued',
  recipient_hash bytea,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_deliveries_status_ck check (status in ('queued', 'accepted', 'delivered', 'failed', 'bounced', 'cancelled')),
  unique (idempotency_key)
);

create index if not exists notification_deliveries_status_idx
  on notification_deliveries (status, created_at);

-- Não persistir senha, token bruto, link completo de reset ou conteúdo fiscal fora do storage autorizado.


-- Reversa Tax — controle de tabelas PER/DCOMP e pacotes de recuperação
-- Referência de migration; executar somente após revisão do schema de produção.

create table if not exists perdcomp_table_versions (
  id uuid primary key default gen_random_uuid(),
  version_number integer not null,
  source_url text not null,
  source_updated_at timestamptz,
  retrieved_at timestamptz not null default now(),
  source_sha256 varchar(64) not null,
  storage_key text,
  parse_status varchar(30) not null default 'received',
  normalized_sha256 varchar(64),
  tables_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint perdcomp_table_versions_status_ck check (parse_status in ('received', 'parsed', 'validated', 'failed', 'superseded')),
  unique (version_number, source_sha256)
);

create index if not exists perdcomp_table_versions_current_idx
  on perdcomp_table_versions (version_number desc, parse_status);

create table if not exists recovery_packages (
  id uuid primary key default gen_random_uuid(),
  tax_case_id uuid not null references tax_cases(id),
  taxpayer_id uuid not null references taxpayers(id),
  perdcomp_table_version_id uuid references perdcomp_table_versions(id),
  package_type varchar(40) not null,
  status varchar(40) not null default 'draft',
  period_start date not null,
  period_end date not null,
  total_potential numeric(20,2) not null default 0,
  total_approved numeric(20,2) not null default 0,
  assumptions jsonb not null default '[]'::jsonb,
  source_refs jsonb not null default '[]'::jsonb,
  created_by uuid not null references users(id),
  approved_by uuid references users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recovery_packages_type_ck check (package_type in ('perdcomp_compensacao', 'perdcomp_restituicao', 'efd_retificadora', 'memoria_trabalho')),
  constraint recovery_packages_status_ck check (status in ('draft', 'in_review', 'approved', 'blocked', 'exported', 'cancelled'))
);

create table if not exists recovery_package_items (
  id uuid primary key default gen_random_uuid(),
  recovery_package_id uuid not null references recovery_packages(id),
  finding_id uuid references tax_findings(id),
  perdcomp_table_code varchar(120),
  amount numeric(20,2) not null default 0,
  status varchar(30) not null default 'included',
  notes text,
  created_at timestamptz not null default now(),
  constraint recovery_package_items_status_ck check (status in ('included', 'excluded', 'pending_review'))
);


-- Reversa Tax — domínio de conhecimento e motor de oportunidades
-- Depende de users, organizations, taxpayers, tax_cases e tax_rule_versions.

create table if not exists opportunity_catalog (
  id uuid primary key default gen_random_uuid(),
  opportunity_key varchar(20) not null unique,
  name text not null,
  category varchar(40) not null,
  risk_level varchar(20) not null,
  catalog_status varchar(30) not null default 'active',
  implementation_status varchar(50) not null default 'needs_rule_validation',
  definition jsonb not null default '{}'::jsonb,
  source_refs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunity_catalog_risk_ck check (risk_level in ('baixo', 'medio', 'alto'))
);

create table if not exists assessment_questions (
  id uuid primary key default gen_random_uuid(),
  question_key varchar(120) not null unique,
  prompt text not null,
  answer_type varchar(30) not null,
  options jsonb not null default '[]'::jsonb,
  applies_to jsonb not null default '[]'::jsonb,
  version varchar(40) not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists assessments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  taxpayer_id uuid not null references taxpayers(id),
  status varchar(30) not null default 'draft',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_by uuid not null references users(id),
  metadata jsonb not null default '{}'::jsonb,
  constraint assessments_status_ck check (status in ('draft', 'in_progress', 'completed', 'superseded'))
);

create table if not exists assessment_answers (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references assessments(id),
  question_id uuid not null references assessment_questions(id),
  answer jsonb not null,
  answered_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (assessment_id, question_id)
);

create table if not exists opportunities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  taxpayer_id uuid not null references taxpayers(id),
  tax_case_id uuid references tax_cases(id),
  catalog_id uuid not null references opportunity_catalog(id),
  assessment_id uuid references assessments(id),
  status varchar(40) not null default 'discovered',
  eligibility_state varchar(30) not null default 'needs_validation',
  risk_class varchar(20),
  score numeric(6,2),
  current_rule_version_id uuid references tax_rule_versions(id),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunities_status_ck check (status in ('discovered', 'screening', 'probably_eligible', 'document_validation', 'calculated', 'qualified', 'decision_maker', 'proposal', 'converted', 'not_eligible', 'rejected', 'duplicated', 'insufficient_data', 'legal_review')),
  constraint opportunities_eligibility_ck check (eligibility_state in ('eligible', 'probably_eligible', 'needs_validation', 'not_eligible')),
  constraint opportunities_risk_class_ck check (risk_class is null or risk_class in ('possivel', 'provavel', 'remoto'))
);

create index if not exists opportunities_tenant_status_idx on opportunities (organization_id, status, updated_at desc);

create table if not exists opportunity_scores (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references opportunities(id),
  financial_potential numeric(6,2),
  scalability numeric(6,2),
  eligibility numeric(6,2),
  legal_security numeric(6,2),
  execution numeric(6,2),
  market_size numeric(6,2),
  automation numeric(6,2),
  opportunity_score numeric(6,2),
  strategic_score numeric(6,2),
  risk_gate_action varchar(40),
  formula_version varchar(40) not null,
  calculated_at timestamptz not null default now(),
  unique (opportunity_id, formula_version)
);

create table if not exists financial_estimates (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references opportunities(id),
  period_start date not null,
  period_end date not null,
  base_amount numeric(20,2),
  rate numeric(12,8),
  estimated_amount numeric(20,2) not null default 0,
  validated_amount numeric(20,2),
  confidence varchar(30) not null default 'preliminary',
  formula jsonb not null default '{}'::jsonb,
  assumptions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint financial_estimates_confidence_ck check (confidence in ('preliminary', 'medium', 'high', 'validated'))
);

create table if not exists validations (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references opportunities(id),
  validation_type varchar(40) not null,
  status varchar(30) not null default 'pending',
  requirement text not null,
  evidence_refs jsonb not null default '[]'::jsonb,
  decision text,
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint validations_status_ck check (status in ('pending', 'in_review', 'accepted', 'rejected', 'not_applicable'))
);

create table if not exists opportunity_events (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references opportunities(id),
  actor_user_id uuid references users(id),
  from_status varchar(40),
  to_status varchar(40) not null,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists system_parameters (
  key varchar(160) primary key,
  value jsonb not null,
  version varchar(40) not null,
  effective_from date,
  effective_to date,
  source_refs jsonb not null default '[]'::jsonb,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table if not exists auth_rate_limits (
  bucket_key varchar(128) primary key,
  window_started timestamptz not null,
  request_count integer not null default 0,
  updated_at timestamptz not null default now()
);


alter table users add column if not exists username varchar(120);

create unique index if not exists users_username_normalized_uq on users (lower(username)) where username is not null;

-- ===== 002_org_cases_stage.sql =====
-- 002 — P1-1: empresas/casos por organização, fase comercial e bootstrap da organização padrão.
-- Somente expansão (expand/contract): nenhuma coluna ou tabela é removida.

-- Fase comercial do caso (funil: a apresentar → apresentado → aguardando autorização → contrato).
-- É independente de tax_cases.status (estado técnico) e não equivale a crédito aprovado (RB-09).
alter table tax_cases add column if not exists commercial_stage varchar(40) not null default 'a_apresentar'
  check (commercial_stage in ('a_apresentar', 'apresentado', 'aguardando_autorizacao', 'contrato', 'perdido'));

alter table tax_cases add column if not exists taxpayer_id uuid references taxpayers(id);

create index if not exists tax_cases_taxpayer_idx on tax_cases (taxpayer_id);

-- Um CNPJ por organização.
create unique index if not exists taxpayers_org_cnpj_uq on taxpayers (organization_id, cnpj_normalized);

create index if not exists organization_members_user_idx on organization_members (user_id);

-- Organização padrão (Argus Prime) quando ainda não houver nenhuma.
insert into organizations (name)
select 'Argus Prime'
where not exists (select 1 from organizations);

-- Usuários ativos já existentes e sem vínculo passam a ser administradores da organização padrão.
-- Novos usuários entram somente por convite (POST /api/v1/members).
insert into organization_members (organization_id, user_id, role, status)
select (select id from organizations order by created_at, id limit 1), u.id, 'admin', 'active'
from users u
where u.status = 'active'
  and not exists (select 1 from organization_members m where m.user_id = u.id);

-- ===== 003_owner_name.sql =====
-- Nome do proprietário criado pelo bootstrap provisório (antes: "Administrador Argus Prime").
-- [seguro] update de nome do proprietario omitido: nao altera dados existentes

-- ===== 004_crm.sql =====
-- 004 — CRM nativo do Reversa: contatos, linha do tempo (notas, ligações, reuniões, e-mails, tarefas, agente)
-- e próximo passo do caso. Somente expansão. O funil continua sendo tax_cases.commercial_stage.

create table if not exists crm_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  taxpayer_id uuid not null references taxpayers(id) on delete cascade,
  name varchar(160) not null,
  role varchar(120),
  email varchar(240),
  phone varchar(40),
  is_primary boolean not null default false,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists crm_contacts_taxpayer_idx on crm_contacts (organization_id, taxpayer_id);

create table if not exists crm_activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  taxpayer_id uuid not null references taxpayers(id) on delete cascade,
  case_id uuid references tax_cases(id) on delete set null,
  type varchar(20) not null check (type in ('note', 'call', 'meeting', 'email', 'task', 'agent')),
  subject varchar(240),
  body text,
  due_at timestamptz,
  done_at timestamptz,
  assignee_user_id uuid references users(id),
  meta jsonb not null default '{}'::jsonb,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists crm_activities_taxpayer_idx on crm_activities (organization_id, taxpayer_id, created_at desc);

create index if not exists crm_activities_tasks_idx on crm_activities (organization_id, assignee_user_id, done_at, due_at);

alter table tax_cases add column if not exists next_step varchar(240);

alter table tax_cases add column if not exists expected_close_date date;

-- ===== 005_lei_do_bem.sql =====
-- 005 — Módulo Lei do Bem (Lei 11.196/2005): um caso por empresa e ano-base, com os dados extraídos dos arquivos
-- (os arquivos em si não ficam guardados), o último cálculo do motor e a trilha das quatro revisões humanas.
-- Somente expansão.

create table if not exists ldb_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  taxpayer_id uuid references taxpayers(id) on delete set null,
  cnpj varchar(14) not null,
  legal_name varchar(240) not null,
  base_year integer not null check (base_year between 2006 and 2100),
  status varchar(20) not null default 'rascunho' check (status in ('rascunho', 'em_revisao', 'aprovado', 'enviado', 'arquivado')),
  data jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  reviews jsonb not null default '[]'::jsonb,
  formpd_receipt varchar(120),
  formpd_sent_at date,
  created_by uuid references users(id),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ldb_cases_org_cnpj_year_idx on ldb_cases (organization_id, cnpj, base_year);

create index if not exists ldb_cases_org_updated_idx on ldb_cases (organization_id, updated_at desc);

-- ===== 006_client_authorizations.sql =====
-- Autorização do cliente separada da revisão técnica do crédito.
create table if not exists client_authorizations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  tax_case_id uuid not null references tax_cases(id),
  created_by uuid not null references users(id),
  token_hash varchar(64) not null unique,
  snapshot jsonb not null,
  snapshot_hash varchar(64) not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  accepted_at timestamptz,
  representative_name varchar(240),
  representative_email varchar(254),
  representative_role varchar(240),
  selected_theses jsonb,
  created_at timestamptz not null default now(),
  constraint client_authorizations_receipt_ck check (
    accepted_at is null or (representative_name is not null and representative_email is not null
      and representative_role is not null and selected_theses is not null)
  )
);
create index if not exists client_authorizations_case_idx on client_authorizations (organization_id, tax_case_id, created_at);

-- ===== 007_parceiros.sql =====
-- 007 — Parceiros: cada parceiro é uma organização isolada; a organização mais antiga é a plataforma (Argus Prime).
-- Somente expansão: nenhuma coluna ou tabela é removida.
alter table organizations add column if not exists kind varchar(20) not null default 'interna'
  check (kind in ('plataforma', 'interna', 'parceiro'));

alter table organizations add column if not exists cnpj varchar(14);

alter table organizations add column if not exists commission_pct numeric(5,2) not null default 0
  check (commission_pct >= 0 and commission_pct <= 100);

alter table organizations add column if not exists responsible_name varchar(180);

alter table organizations add column if not exists responsible_email varchar(320);

alter table organizations add column if not exists notes text;

-- A organização padrão (a primeira criada) é a plataforma.
-- [seguro] update de kind da organizacao omitido: nao altera dados existentes

create index if not exists taxpayers_cnpj_idx on taxpayers (cnpj_normalized);

-- ===== 008_visao_master.sql =====
-- 008 — Visão do todo: o master pode conceder a membros da plataforma (Argus Prime) acesso ao painel Master.
-- Somente expansão: nenhuma coluna ou tabela é removida.
alter table organization_members add column if not exists master boolean not null default false;

-- ===== 009_execucao.sql =====
-- 009 — Execução pós-contrato (retificação → aprovação → validação do contador → transmissão → PER/DCOMP).
-- Só a plataforma (Argus Prime) opera; o parceiro não acessa. Somente expansão: nada é removido.
create table if not exists recovery_executions (
  id uuid primary key default gen_random_uuid(),
  tax_case_id uuid not null unique references tax_cases(id),
  case_organization_id uuid not null references organizations(id),
  stage varchar(40) not null default 'contrato_assinado',
  summary text,
  requires_accountant boolean not null default false,
  approved_by uuid references users(id),
  approved_at timestamptz,
  accountant_email varchar(320),
  accountant_token_hash char(64),
  accountant_sent_at timestamptz,
  accountant_expires_at timestamptz,
  accountant_opened_at timestamptz,
  accountant_name varchar(240),
  accountant_response varchar(30),
  accountant_comment text,
  accountant_responded_at timestamptz,
  receipts jsonb not null default '[]'::jsonb,
  artifacts jsonb not null default '[]'::jsonb,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recovery_executions_stage_ck check (stage in ('contrato_assinado', 'apuracao_definitiva', 'retificacao_preparada', 'pre_validacao',
    'aguardando_aprovacao', 'aprovado', 'validacao_contador', 'transmitido', 'perdcomp', 'acompanhamento', 'concluido', 'cancelado')),
  constraint recovery_executions_accountant_ck check (accountant_response is null or accountant_response in ('validado', 'validado_assinado', 'com_ressalvas'))
);

create unique index if not exists recovery_executions_accountant_token_uq on recovery_executions (accountant_token_hash) where accountant_token_hash is not null;
create index if not exists recovery_executions_stage_idx on recovery_executions (stage, updated_at desc);

create table if not exists recovery_execution_events (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references recovery_executions(id),
  stage_from varchar(40),
  stage_to varchar(40),
  kind varchar(40) not null,
  note text,
  actor_user_id uuid references users(id),
  actor_label varchar(240),
  created_at timestamptz not null default now()
);

create index if not exists recovery_execution_events_exec_idx on recovery_execution_events (execution_id, created_at);

-- ===== 010_contratacao.sql =====
-- Link de contratação: teses com oposição, contrato padrão e assinatura eletrônica com código por e-mail.
alter table client_authorizations add column if not exists opposed_theses jsonb;
alter table client_authorizations add column if not exists representative_cpf varchar(11);
alter table client_authorizations add column if not exists signer_ip varchar(80);
alter table client_authorizations add column if not exists signer_user_agent varchar(400);
alter table client_authorizations add column if not exists contract_hash char(64);
alter table client_authorizations add column if not exists otp_hash char(64);
alter table client_authorizations add column if not exists otp_email varchar(254);
alter table client_authorizations add column if not exists otp_expires_at timestamptz;
alter table client_authorizations add column if not exists otp_attempts integer not null default 0;

-- ===== 011_pgfn.sql =====
-- 011 — Transação PGFN no Reversa (a partir do rascunho aprovado por André; spec 0.2).
-- Somente expansão: nada existente é alterado. Todo acesso é filtrado por organization_id no domínio (lib/domain/pgfn.js);
-- FK sozinha não é autorização. Retenção/descarte de snapshots: a definir antes de usar dados reais em escala.
-- Diferença em relação ao rascunho: rule_code aceita também P01+ (verificações provisórias) enquanto o catálogo R01–R18 não é informado.

create table if not exists pgfn_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  tax_case_id uuid not null references tax_cases(id),
  taxpayer_id uuid not null references taxpayers(id),
  proposal_kind varchar(40) not null default 'not_confirmed',
  dossier_status varchar(40) not null default 'draft',
  viability_status varchar(40) not null default 'nao_avaliado',
  dossier_version integer not null default 1,
  primary_rate_kind varchar(40),
  facts jsonb not null default '{}'::jsonb,
  last_input_hash varchar(64),
  last_solver_run_id uuid,
  created_by uuid references users(id),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pgfn_cases_proposal_kind_ck check (proposal_kind in (
    'individual', 'individual_simplified', 'exceptional', 'adhesion', 'not_confirmed'
  )),
  constraint pgfn_cases_dossier_status_ck check (dossier_status in (
    'draft', 'collecting', 'ready_for_review', 'active_monitoring', 'archived'
  )),
  constraint pgfn_cases_viability_status_ck check (viability_status in (
    'viavel', 'viavel_com_pendencia', 'inviavel', 'nao_avaliado'
  )),
  constraint pgfn_cases_primary_rate_ck check (primary_rate_kind is null or primary_rate_kind in (
    'irpj_csll_tax_rate', 'cashflow_discount_rate', 'pgfn_discount_rate'
  )),
  constraint pgfn_cases_hash_ck check (last_input_hash is null or last_input_hash ~ '^[a-fA-F0-9]{64}$'),
  constraint pgfn_cases_version_ck check (dossier_version > 0),
  unique (organization_id, tax_case_id)
);

create index if not exists pgfn_cases_org_updated_idx
  on pgfn_cases (organization_id, updated_at desc);
create index if not exists pgfn_cases_taxpayer_idx
  on pgfn_cases (organization_id, taxpayer_id, updated_at desc);
create index if not exists pgfn_cases_org_viability_idx
  on pgfn_cases (organization_id, viability_status, updated_at desc);

create table if not exists pgfn_debts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  pgfn_case_id uuid not null references pgfn_cases(id),
  external_debt_reference varchar(160),
  debt_kind varchar(40) not null default 'desconhecido',
  administrative_status varchar(40) not null default 'desconhecida',
  inscription_date date,
  reference_date date not null,
  original_amount numeric(20,2),
  principal_amount numeric(20,2),
  interest_amount numeric(20,2),
  penalty_amount numeric(20,2),
  legal_charges_amount numeric(20,2),
  updated_balance numeric(20,2),
  guarantee_amount numeric(20,2),
  source_type varchar(40) not null default 'desconhecida',
  source_document_id uuid references documents(id),
  source_import_id uuid,
  source_reference jsonb not null default '{}'::jsonb,
  data_status varchar(40) not null default 'informado_nao_validado',
  notes text,
  created_by uuid references users(id),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pgfn_debts_kind_ck check (debt_kind in (
    'principal', 'multa', 'juros', 'encargo', 'previdenciario', 'tributario', 'outro', 'desconhecido'
  )),
  constraint pgfn_debts_admin_status_ck check (administrative_status in (
    'ativa', 'suspensa', 'garantida', 'parcelada', 'quitada', 'contestada', 'outra', 'desconhecida'
  )),
  constraint pgfn_debts_source_type_ck check (source_type in (
    'api_interna', 'pdf_manual', 'planilha_estruturada', 'entrada_manual', 'desconhecida'
  )),
  constraint pgfn_debts_data_status_ck check (data_status in (
    'confirmado', 'informado_nao_validado', 'desconhecido'
  )),
  constraint pgfn_debts_amounts_nonnegative_ck check (
    (original_amount is null or original_amount >= 0) and
    (principal_amount is null or principal_amount >= 0) and
    (interest_amount is null or interest_amount >= 0) and
    (penalty_amount is null or penalty_amount >= 0) and
    (legal_charges_amount is null or legal_charges_amount >= 0) and
    (updated_balance is null or updated_balance >= 0) and
    (guarantee_amount is null or guarantee_amount >= 0)
  )
);

create index if not exists pgfn_debts_case_idx
  on pgfn_debts (organization_id, pgfn_case_id, reference_date desc);
create index if not exists pgfn_debts_source_doc_idx
  on pgfn_debts (source_document_id) where source_document_id is not null;
create unique index if not exists pgfn_debts_external_ref_uq
  on pgfn_debts (organization_id, pgfn_case_id, external_debt_reference)
  where external_debt_reference is not null;

create table if not exists pgfn_solver_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  pgfn_case_id uuid not null references pgfn_cases(id),
  run_number integer not null,
  run_status varchar(30) not null default 'queued',
  solver_name varchar(80),
  engine_version varchar(40) not null,
  catalog_version varchar(80) not null,
  input_hash varchar(64) not null,
  input_snapshot jsonb not null,
  rule_snapshot jsonb not null default '[]'::jsonb,
  solver_parameters jsonb not null default '{}'::jsonb,
  objective_value numeric(24,4),
  solver_gap numeric(16,10),
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms bigint,
  error_code varchar(120),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  constraint pgfn_solver_runs_status_ck check (run_status in (
    'queued', 'running', 'completed', 'infeasible', 'timed_out', 'failed', 'cancelled'
  )),
  constraint pgfn_solver_runs_hash_ck check (input_hash ~ '^[a-fA-F0-9]{64}$'),
  constraint pgfn_solver_runs_number_ck check (run_number > 0),
  constraint pgfn_solver_runs_gap_ck check (solver_gap is null or solver_gap >= 0),
  constraint pgfn_solver_runs_duration_ck check (duration_ms is null or duration_ms >= 0),
  unique (organization_id, pgfn_case_id, run_number)
);

create index if not exists pgfn_solver_runs_case_idx
  on pgfn_solver_runs (organization_id, pgfn_case_id, created_at desc);
create index if not exists pgfn_solver_runs_status_idx
  on pgfn_solver_runs (run_status, created_at);

create table if not exists pgfn_scenarios (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  solver_run_id uuid not null references pgfn_solver_runs(id),
  scenario_key varchar(120) not null,
  label varchar(40) not null,
  recommendation varchar(40) not null default 'not_evaluated',
  nominal_cost numeric(24,2),
  present_value_cost numeric(24,2),
  short_term_cash_need numeric(24,2),
  long_term_economic_impact numeric(24,2),
  pareto_optimal boolean,
  solver_solution jsonb not null default '{}'::jsonb,
  missing_inputs jsonb not null default '[]'::jsonb,
  assumptions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint pgfn_scenarios_label_ck check (label in (
    'viavel', 'viavel_com_pendencia', 'inviavel', 'nao_avaliado'
  )),
  constraint pgfn_scenarios_recommendation_ck check (recommendation in (
    'recommend', 'conditional', 'do_not_recommend', 'not_evaluated'
  )),
  constraint pgfn_scenarios_amounts_nonnegative_ck check (
    (nominal_cost is null or nominal_cost >= 0) and
    (present_value_cost is null or present_value_cost >= 0) and
    (short_term_cash_need is null or short_term_cash_need >= 0)
  ),
  unique (solver_run_id, scenario_key)
);

create index if not exists pgfn_scenarios_run_idx
  on pgfn_scenarios (organization_id, solver_run_id, label);

create table if not exists pgfn_constraint_results (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  scenario_id uuid not null references pgfn_scenarios(id),
  rule_code varchar(3) not null,
  tax_rule_version_id uuid references tax_rule_versions(id),
  evaluation_status varchar(30) not null,
  severity varchar(20) not null,
  reason_code varchar(120) not null,
  evaluated_values jsonb not null default '{}'::jsonb,
  source_refs jsonb not null default '[]'::jsonb,
  evidence_document_ids jsonb not null default '[]'::jsonb,
  explanation text,
  created_at timestamptz not null default now(),
  -- R01–R18 são os códigos do catálogo de André (ainda não informado); P01+ são as verificações provisórias baseadas em norma já conferida.
  constraint pgfn_constraint_results_rule_code_ck check (rule_code ~ '^(R(0[1-9]|1[0-8])|P[0-9]{2})$'),
  constraint pgfn_constraint_results_status_ck check (evaluation_status in (
    'satisfied', 'violated', 'unknown', 'not_applicable'
  )),
  constraint pgfn_constraint_results_severity_ck check (severity in (
    'hard', 'soft', 'informational'
  )),
  unique (scenario_id, rule_code)
);

create index if not exists pgfn_constraint_results_scenario_idx
  on pgfn_constraint_results (organization_id, scenario_id, evaluation_status);
create index if not exists pgfn_constraint_results_rule_idx
  on pgfn_constraint_results (rule_code, tax_rule_version_id);

create table if not exists pgfn_rate_sensitivities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  scenario_id uuid not null references pgfn_scenarios(id),
  rate_kind varchar(40) not null,
  baseline_rate numeric(16,10),
  alternative_rate numeric(16,10),
  rate_unit varchar(20) not null,
  is_primary boolean not null default false,
  effective_from date,
  short_term_horizon_months integer,
  long_term_horizon_months integer,
  short_term_cost_delta numeric(24,2),
  long_term_cost_delta numeric(24,2),
  nominal_cost_delta numeric(24,2),
  present_value_cost_delta numeric(24,2),
  breakeven_month integer,
  recommendation varchar(40) not null default 'not_evaluated',
  reason_codes jsonb not null default '[]'::jsonb,
  source_refs jsonb not null default '[]'::jsonb,
  explanation jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint pgfn_rate_sens_kind_ck check (rate_kind in (
    'irpj_csll_tax_rate', 'cashflow_discount_rate', 'pgfn_discount_rate'
  )),
  constraint pgfn_rate_sens_unit_ck check (rate_unit in ('fraction', 'percent', 'basis_points')),
  constraint pgfn_rate_sens_recommendation_ck check (recommendation in (
    'recommend', 'conditional', 'do_not_recommend', 'not_evaluated'
  )),
  constraint pgfn_rate_sens_rates_ck check (
    (baseline_rate is null or baseline_rate >= 0) and
    (alternative_rate is null or alternative_rate >= 0)
  ),
  constraint pgfn_rate_sens_horizon_ck check (
    (short_term_horizon_months is null or short_term_horizon_months > 0) and
    (long_term_horizon_months is null or long_term_horizon_months > 0) and
    (breakeven_month is null or breakeven_month >= 0)
  )
);

create index if not exists pgfn_rate_sens_scenario_idx
  on pgfn_rate_sensitivities (organization_id, scenario_id, rate_kind, is_primary);

create table if not exists pgfn_decision_briefs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  scenario_id uuid not null references pgfn_scenarios(id),
  audience varchar(20) not null,
  brief_version integer not null default 1,
  template_version varchar(40) not null,
  status varchar(30) not null default 'draft',
  content jsonb not null,
  created_by uuid references users(id),
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pgfn_decision_briefs_audience_ck check (audience in ('parceiro', 'tecnico')),
  constraint pgfn_decision_briefs_status_ck check (status in ('draft', 'in_review', 'approved', 'rejected')),
  constraint pgfn_decision_briefs_version_ck check (brief_version > 0),
  unique (scenario_id, audience, brief_version)
);

create index if not exists pgfn_decision_briefs_scenario_idx
  on pgfn_decision_briefs (organization_id, scenario_id, audience, status);

create table if not exists pgfn_review_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  scenario_id uuid not null references pgfn_scenarios(id),
  decision_brief_id uuid references pgfn_decision_briefs(id),
  actor_user_id uuid not null references users(id),
  decision varchar(20) not null,
  audience varchar(20),
  reason text,
  decision_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint pgfn_review_events_decision_ck check (decision in ('approve', 'reject', 'return')),
  constraint pgfn_review_events_audience_ck check (audience is null or audience in ('parceiro', 'tecnico'))
);

create index if not exists pgfn_review_events_scenario_idx
  on pgfn_review_events (organization_id, scenario_id, created_at desc);

create table if not exists pgfn_monitoring_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  pgfn_case_id uuid not null references pgfn_cases(id),
  source_key varchar(120) not null,
  external_event_id varchar(240),
  dedupe_key varchar(240) not null,
  event_class char(1) not null,
  event_status varchar(30) not null default 'detected',
  event_type varchar(120) not null,
  payload_hash varchar(64) not null,
  before_snapshot jsonb not null default '{}'::jsonb,
  after_snapshot jsonb not null default '{}'::jsonb,
  rule_version varchar(40),
  detected_at timestamptz not null default now(),
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  resolution jsonb not null default '{}'::jsonb,
  constraint pgfn_monitoring_events_class_ck check (event_class in ('A', 'B', 'C')),
  constraint pgfn_monitoring_events_status_ck check (event_status in (
    'detected', 'queued', 'in_review', 'resolved', 'ignored', 'deduped', 'source_unavailable'
  )),
  constraint pgfn_monitoring_events_hash_ck check (payload_hash ~ '^[a-fA-F0-9]{64}$'),
  unique (organization_id, dedupe_key)
);

create index if not exists pgfn_monitoring_events_queue_idx
  on pgfn_monitoring_events (organization_id, event_class, event_status, detected_at desc);
create index if not exists pgfn_monitoring_events_case_idx
  on pgfn_monitoring_events (organization_id, pgfn_case_id, detected_at desc);

create table if not exists pgfn_monitoring_cursors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  pgfn_case_id uuid not null references pgfn_cases(id),
  source_key varchar(120) not null,
  last_checked_at timestamptz,
  last_event_cursor text,
  source_status varchar(30) not null default 'not_configured',
  last_error_code varchar(120),
  updated_at timestamptz not null default now(),
  constraint pgfn_monitoring_cursors_status_ck check (source_status in (
    'not_configured', 'active', 'unavailable', 'paused'
  )),
  unique (organization_id, pgfn_case_id, source_key)
);

create index if not exists pgfn_monitoring_cursors_due_idx
  on pgfn_monitoring_cursors (source_status, last_checked_at);

-- ===== 012_diagnosticos.sql =====
-- 012 — Diagnósticos identificados e versionados (DX-AAAA-0001), por cliente e tipo. Somente expansão.
create sequence if not exists diagnostics_code_seq;

create table if not exists diagnostics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  taxpayer_id uuid not null references taxpayers(id),
  tax_case_id uuid references tax_cases(id),
  code varchar(24) not null unique,
  tipo varchar(20) not null check (tipo in ('pis_cofins', 'previdenciario', 'icms', 'completo')),
  versao integer not null check (versao >= 1),
  status varchar(20) not null default 'vigente' check (status in ('vigente', 'substituido')),
  valor_total numeric(18,2) not null default 0,
  valor_no_prazo numeric(18,2) not null default 0,
  periodo_ini date,
  periodo_fim date,
  engine_version varchar(40),
  batch_id uuid,
  resumo jsonb not null default '{}'::jsonb,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (taxpayer_id, tipo, versao)
);

create index if not exists diagnostics_org_idx on diagnostics (organization_id, created_at desc);
create index if not exists diagnostics_taxpayer_idx on diagnostics (taxpayer_id, tipo, versao desc);
create unique index if not exists diagnostics_vigente_uq on diagnostics (taxpayer_id, tipo) where status = 'vigente';

-- ===== 013_case_history.sql =====
-- 013 — Histórico de alterações dos cards do CRM (quem, quando, o que mudou). Somente expansão.
create table if not exists case_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  tax_case_id uuid references tax_cases(id) on delete set null,
  taxpayer_id uuid references taxpayers(id) on delete cascade,
  actor_user_id uuid references users(id),
  actor_name varchar(180),
  actor_org_kind varchar(20),
  kind varchar(20) not null check (kind in ('edicao', 'fase', 'contato', 'atividade', 'exclusao', 'restauracao', 'diagnostico')),
  field varchar(80),
  old_value text,
  new_value text,
  created_at timestamptz not null default now()
);

create index if not exists case_history_taxpayer_idx on case_history (organization_id, taxpayer_id, created_at desc);
create index if not exists case_history_case_idx on case_history (tax_case_id, created_at desc);

-- ===== 014_gov.sql =====
-- 014 — Módulo Reversa Gov: IRRF Municipal (isolado, aditivo, sem modificar tabelas existentes)
-- Prefixo obrigatório gov_ para isolamento lógico.
-- Nenhuma tabela existente é alterada, renomeada ou removida.

create table if not exists gov_municipalities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  ibge_code char(7) not null,
  name varchar(240) not null,
  state char(2) not null,
  cnpj_root char(8),
  cnpj char(14),
  status varchar(30) not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gov_municipalities_status_ck check (status in ('active', 'suspended', 'archived')),
  constraint gov_municipalities_ibge_uq unique (ibge_code)
);

create index if not exists gov_municipalities_org_idx on gov_municipalities (organization_id, state);

create table if not exists gov_entities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  municipality_id uuid not null references gov_municipalities(id),
  cnpj char(14) not null,
  legal_name varchar(240) not null,
  legal_nature_code varchar(20),
  entity_type varchar(40) not null check (entity_type in ('direct_admin', 'autarchy', 'foundation', 'consortium', 'other')),
  is_active boolean not null default true,
  valid_from date,
  valid_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gov_entities_cnpj_uq unique (cnpj)
);

create index if not exists gov_entities_municipality_idx on gov_entities (municipality_id);
create index if not exists gov_entities_org_idx on gov_entities (organization_id);

create table if not exists gov_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name varchar(180) not null,
  source_type varchar(40) not null check (source_type in ('transparency_portal', 'tce', 'pncp', 'siconfi', 'official_gazette', 'upload')),
  base_url text,
  terms_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists gov_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  entity_id uuid references gov_entities(id),
  original_name varchar(255) not null,
  mime_type varchar(120) not null,
  size_bytes bigint not null,
  checksum_sha256 varchar(64) not null,
  classification varchar(40) not null default 'internal' check (classification in ('public', 'internal', 'confidential', 'fiscal_restricted', 'personal_data')),
  period_start date,
  period_end date,
  received_at timestamptz not null default now(),
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now(),
  -- ingestao (migration 017)
  municipality_id uuid references gov_municipalities(id),
  content bytea,
  content_text text,
  parser_kind varchar(40),
  process_status varchar(20) not null default 'PENDING',
  parsed_summary jsonb not null default '{}'::jsonb,
  period_label varchar(20),
  error_message text
);

create index if not exists gov_documents_org_idx on gov_documents (organization_id, received_at desc);
create index if not exists gov_documents_municipality_idx on gov_documents (municipality_id);

create table if not exists gov_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  entity_id uuid not null references gov_entities(id),
  supplier_cnpj char(14),
  supplier_name varchar(240),
  invoice_id varchar(120),
  empenho_id varchar(120),
  liquidation_id varchar(120),
  payment_date date,
  competence date,
  gross_amount_cents bigint not null default 0,
  net_amount_cents bigint not null default 0,
  currency char(3) not null default 'BRL',
  source_document_id uuid references gov_documents(id),
  source_locator text,
  created_at timestamptz not null default now()
);

create index if not exists gov_payments_entity_idx on gov_payments (entity_id, payment_date);
create index if not exists gov_payments_supplier_idx on gov_payments (organization_id, supplier_cnpj);

create table if not exists gov_withholdings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  payment_id uuid not null references gov_payments(id),
  tax_type varchar(40) not null default 'IRRF',
  tax_base_cents bigint not null default 0,
  rate numeric(9,6),
  withheld_amount_cents bigint not null default 0,
  withholding_date date,
  nature_code varchar(30),
  cnr varchar(20),
  legal_owner varchar(20) not null default 'UNKNOWN' check (legal_owner in ('MUNICIPAL', 'FEDERAL', 'UNKNOWN')),
  source_document_id uuid references gov_documents(id),
  created_at timestamptz not null default now()
);

create index if not exists gov_withholdings_payment_idx on gov_withholdings (payment_id);

create table if not exists gov_declarations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  entity_id uuid not null references gov_entities(id),
  period date not null,
  system_name varchar(120) not null,
  event_type varchar(80),
  receipt_id varchar(120),
  cnr varchar(20),
  declared_amount_cents bigint not null default 0,
  destination_status varchar(40) not null default 'UNKNOWN' check (destination_status in ('NOT_SENT_TO_DCTFWEB', 'SENT_TO_DCTFWEB', 'OTHER', 'UNKNOWN')),
  source_document_id uuid references gov_documents(id),
  created_at timestamptz not null default now()
);

create index if not exists gov_declarations_entity_period_idx on gov_declarations (entity_id, period);

create table if not exists gov_remittances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  entity_id uuid not null references gov_entities(id),
  payment_reference varchar(120),
  revenue_code varchar(40),
  payment_date date,
  amount_cents bigint not null default 0,
  recipient varchar(240),
  bank_reference varchar(120),
  source_document_id uuid references gov_documents(id),
  created_at timestamptz not null default now()
);

create table if not exists gov_accounting_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  entity_id uuid not null references gov_entities(id),
  account_code varchar(80),
  account_description text,
  competence date not null,
  debit_cents bigint not null default 0,
  credit_cents bigint not null default 0,
  journal_reference varchar(120),
  source_document_id uuid references gov_documents(id),
  created_at timestamptz not null default now()
);

create table if not exists gov_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  entity_id uuid not null references gov_entities(id),
  period date,
  status varchar(40) not null default 'DRAFT' check (status in ('DRAFT', 'NEEDS_EVIDENCE', 'UNDER_REVIEW', 'VALIDATED', 'REJECTED', 'ON_HOLD')),
  gross_candidate_amount_cents bigint not null default 0,
  withheld_amount_cents bigint not null default 0,
  proven_destination_amount_cents bigint not null default 0,
  potential_amount_cents bigint,
  confidence varchar(20) check (confidence in ('LOW', 'MEDIUM', 'HIGH', 'VERIFIED')),
  legal_owner varchar(20) check (legal_owner in ('MUNICIPAL', 'FEDERAL', 'UNKNOWN')),
  cnr varchar(20),
  payment_id uuid references gov_payments(id),
  forward_gain_cents bigint not null default 0,
  rule_id text,
  decision_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists gov_candidates_org_status_idx on gov_candidates (organization_id, status, updated_at desc);

create table if not exists gov_evidence_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  candidate_id uuid not null references gov_candidates(id) on delete cascade,
  document_id uuid references gov_documents(id),
  evidence_type varchar(60) not null,
  record_locator text,
  validation_status varchar(30) not null default 'PENDING' check (validation_status in ('PENDING', 'ACCEPTED', 'REJECTED', 'INCONCLUSIVE')),
  validated_by uuid references users(id),
  validated_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists gov_evidence_links_candidate_idx on gov_evidence_links (candidate_id, validation_status);

create table if not exists gov_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  candidate_id uuid not null references gov_candidates(id) on delete cascade,
  reviewer_id uuid not null references users(id),
  reviewer_role varchar(40) not null,
  decision varchar(30) not null check (decision in ('APPROVE', 'REJECT', 'REQUEST_MORE_EVIDENCE')),
  reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists gov_reviews_candidate_idx on gov_reviews (candidate_id, created_at desc);

create table if not exists gov_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  candidate_id uuid not null references gov_candidates(id),
  procedure_type varchar(80),
  protocol_number varchar(120),
  protocol_date date,
  recognized_amount_cents bigint,
  recovered_amount_cents bigint,
  recovery_date date,
  status varchar(40) not null default 'OPEN' check (status in ('OPEN', 'DOCUMENTATION', 'LEGAL_REVIEW', 'READY_FOR_PROTOCOL', 'PROTOCOLLED', 'RECOVERED', 'CLOSED', 'REJECTED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists gov_cases_org_status_idx on gov_cases (organization_id, status);

create table if not exists gov_audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  actor_user_id uuid references users(id),
  action varchar(120) not null,
  object_type varchar(80) not null,
  object_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists gov_audit_events_org_time_idx on gov_audit_events (organization_id, occurred_at desc);

-- ===== 015_gov_tenant_integrity.sql =====
-- Correção aditiva: não alterar o checksum de 014_gov.sql.
-- Códigos podem ser cadastrados por mais de uma organização, sem compartilhar dados.
do $$ begin if (select count(*) from gov_municipalities) = 0 then alter table gov_municipalities drop constraint if exists gov_municipalities_ibge_uq; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conrelid = 'gov_municipalities'::regclass and conname = 'gov_municipalities_org_ibge_uq') then alter table gov_municipalities add constraint gov_municipalities_org_ibge_uq unique (organization_id, ibge_code); end if; end $$;
do $$ begin if (select count(*) from gov_entities) = 0 then alter table gov_entities drop constraint if exists gov_entities_cnpj_uq; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conrelid = 'gov_entities'::regclass and conname = 'gov_entities_org_cnpj_uq') then alter table gov_entities add constraint gov_entities_org_cnpj_uq unique (organization_id, cnpj); end if; end $$;

do $$ begin if not exists (select 1 from pg_constraint where conrelid = 'gov_municipalities'::regclass and conname = 'gov_municipalities_org_id_uq') then alter table gov_municipalities add constraint gov_municipalities_org_id_uq unique (organization_id, id); end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conrelid = 'gov_entities'::regclass and conname = 'gov_entities_org_id_uq') then alter table gov_entities add constraint gov_entities_org_id_uq unique (organization_id, id); end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conrelid = 'gov_candidates'::regclass and conname = 'gov_candidates_org_id_uq') then alter table gov_candidates add constraint gov_candidates_org_id_uq unique (organization_id, id); end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conrelid = 'gov_documents'::regclass and conname = 'gov_documents_org_id_uq') then alter table gov_documents add constraint gov_documents_org_id_uq unique (organization_id, id); end if; end $$;

do $$ begin if not exists (select 1 from pg_constraint where conrelid = 'gov_entities'::regclass and conname = 'gov_entities_municipality_org_fk') then alter table gov_entities add constraint gov_entities_municipality_org_fk foreign key (organization_id, municipality_id) references gov_municipalities (organization_id, id); end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conrelid = 'gov_candidates'::regclass and conname = 'gov_candidates_entity_org_fk') then alter table gov_candidates add constraint gov_candidates_entity_org_fk foreign key (organization_id, entity_id) references gov_entities (organization_id, id); end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conrelid = 'gov_evidence_links'::regclass and conname = 'gov_evidence_candidate_org_fk') then alter table gov_evidence_links add constraint gov_evidence_candidate_org_fk foreign key (organization_id, candidate_id) references gov_candidates (organization_id, id) on delete cascade; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conrelid = 'gov_evidence_links'::regclass and conname = 'gov_evidence_document_org_fk') then alter table gov_evidence_links add constraint gov_evidence_document_org_fk foreign key (organization_id, document_id) references gov_documents (organization_id, id); end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conrelid = 'gov_reviews'::regclass and conname = 'gov_reviews_candidate_org_fk') then alter table gov_reviews add constraint gov_reviews_candidate_org_fk foreign key (organization_id, candidate_id) references gov_candidates (organization_id, id) on delete cascade; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conrelid = 'gov_cases'::regclass and conname = 'gov_cases_candidate_org_fk') then alter table gov_cases add constraint gov_cases_candidate_org_fk foreign key (organization_id, candidate_id) references gov_candidates (organization_id, id); end if; end $$;

do $$ begin if not exists (select 1 from pg_constraint where conrelid = 'gov_candidates'::regclass and conname = 'gov_candidates_amounts_ck') then alter table gov_candidates add constraint gov_candidates_amounts_ck check ( gross_candidate_amount_cents between 0 and 9007199254740991 and withheld_amount_cents between 0 and 9007199254740991 and proven_destination_amount_cents between 0 and 9007199254740991 and (potential_amount_cents is null or potential_amount_cents between 0 and 9007199254740991) ); end if; end $$;



-- ===== migrations registradas (o runner do build nao reaplica nada) =====
create table if not exists schema_migrations (
  version varchar(200) primary key,
  checksum varchar(64) not null,
  applied_at timestamptz not null default now()
);
insert into schema_migrations (version, checksum) values ('001_platform.sql', '4469adc80784862cb7a75c97c8d9405ad5ffb1c3325e23c5aece9061339a2883') on conflict (version) do nothing;
insert into schema_migrations (version, checksum) values ('002_org_cases_stage.sql', '75cd47388f73364c7a2831f63ebd8dbab51bc27f2e976dc0a2e868f5a3771d3a') on conflict (version) do nothing;
insert into schema_migrations (version, checksum) values ('003_owner_name.sql', 'd82cbfaeac5882be5e5adcbec0b5b2c5ae7340cf3a615d452cab9a8045949e3c') on conflict (version) do nothing;
insert into schema_migrations (version, checksum) values ('004_crm.sql', '5a077c2b423b9f1b94fc8c53de6bba7f32311196a53200b12204133b67738198') on conflict (version) do nothing;
insert into schema_migrations (version, checksum) values ('005_lei_do_bem.sql', 'bb880c7e231cd281bd04b8fb4b4e86f5ed70e475a333444a46f508c5246acead') on conflict (version) do nothing;
insert into schema_migrations (version, checksum) values ('006_client_authorizations.sql', '6a4eb480e1f641164ef7ba8fd9eef26a0e4b3ec912f08d7c53108e46b2bf85c3') on conflict (version) do nothing;
insert into schema_migrations (version, checksum) values ('007_parceiros.sql', '2429f8d7732a6441644f57be78be7d43552ee93a1bc9dd49ca127acd6aa3b239') on conflict (version) do nothing;
insert into schema_migrations (version, checksum) values ('008_visao_master.sql', '94ba37890dc6e7535e0ffcc17b4502c785d739f3819425a6f6631749939c4e3a') on conflict (version) do nothing;
insert into schema_migrations (version, checksum) values ('009_execucao.sql', '52f98cf0d529f2ef5c3aec22157c476f0552733b23800ccd02de54cc814f4094') on conflict (version) do nothing;
insert into schema_migrations (version, checksum) values ('010_contratacao.sql', 'a7c8d0e0417b787a7fc7df6148cb660db4f7e21667e166e59eb2019e851ce620') on conflict (version) do nothing;
insert into schema_migrations (version, checksum) values ('011_pgfn.sql', 'efb43e027f1bb190251420580f697a40d22bee09402c4308c79a3d7b3d90bb37') on conflict (version) do nothing;
insert into schema_migrations (version, checksum) values ('012_diagnosticos.sql', '7d901e950c7522d6babb3642b7121075583afa6510bd3f9a5ec80e7607a1276c') on conflict (version) do nothing;
insert into schema_migrations (version, checksum) values ('013_case_history.sql', '3f91169e4ce9ca74e615350f3fe63ed183cf8f01e596582bca680e6522b80386') on conflict (version) do nothing;
insert into schema_migrations (version, checksum) values ('014_gov.sql', 'f11c76efe14133ab4714f469755abaff6ef7b7f87660c93e34d3c39c12f602d9') on conflict (version) do nothing;
insert into schema_migrations (version, checksum) values ('015_gov_tenant_integrity.sql', 'edb6158ccef7b8f50959778e3731f15b89388bdd42545d3d60c629373d4d0d44') on conflict (version) do nothing;
insert into schema_migrations (version, checksum) values ('016_suite_access.sql', '3023475482fce95d15ccb8c9ab4ece03f7952a82b28f9ae8287a11e976b03942') on conflict (version) do nothing;
insert into schema_migrations (version, checksum) values ('017_gov_ingestao.sql', 'd090b695104929cf453987087ac27938e301c797692427bd8d694c3f163023d5') on conflict (version) do nothing;
