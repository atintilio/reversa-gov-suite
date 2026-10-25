-- Configuracao de suite (passagem de sessao e integracao server-to-server).
--
-- As suites vivem em ambientes separados: cada uma tem seu conjunto de variaveis
-- de ambiente e seu proprio banco. A URL da suite de destino e o segredo
-- compartilhado costumam ser gravados como variavel de ambiente no deploy,
-- mas ha projetos (principalmente os que respondem por um dominio proprio)
-- cuja configuracao de ambiente nao pode ser alterada pelo deploy. Nesses
-- casos a mesma informacao fica aqui, no banco, e o codigo le daqui.
--
-- Precedencia: variavel de ambiente > banco. O banco e o fallback, nao o
-- dono — quem configura o ambiente continua mandando.
--
-- Nenhum segredo e gravado em codigo nem em migration: o valor vem do
-- cofre e e semeado por tools/semear-suite-config.js.
create table if not exists suite_config (
  key varchar(160) primary key,
  value text not null,
  description varchar(255),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

comment on table suite_config is 'Configuracao de integracao entre suites (URL de destino e segredo compartilhado). Precedencia: variavel de ambiente > banco.';
