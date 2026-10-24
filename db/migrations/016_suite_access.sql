-- 016 — acesso por suite: quem entra em cada suite da plataforma (Reversa Tax, Reversa Gov).
-- A concessao e por membro e por organizacao; a administracao acontece na tela de
-- Usuarios, pelos admins. Nenhuma tabela existente e alterada.
create table if not exists suite_access (
  organization_id uuid not null references organizations(id),
  user_id uuid not null references users(id),
  suite varchar(40) not null check (suite in ('tax','gov')),
  granted_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id, suite)
);

create index if not exists suite_access_org_suite_idx on suite_access (organization_id, suite);

-- Quem ja e membro da organizacao mantem o acesso a suite Tax.
insert into suite_access (organization_id, user_id, suite)
select m.organization_id, m.user_id, 'tax'
from organization_members m
on conflict (organization_id, user_id, suite) do nothing;
