-- 017 — ingestão de documentos e diagnóstico do módulo IRRF Municipal.
-- Aditivo: apenas colunas novas em gov_documents e índices de apoio.
-- Nenhuma tabela existente é recriada e nenhum dado é alterado.
alter table gov_documents add column if not exists municipality_id uuid references gov_municipalities(id);
alter table gov_documents add column if not exists content bytea;
alter table gov_documents add column if not exists content_text text;
alter table gov_documents add column if not exists parser_kind varchar(40);
alter table gov_documents add column if not exists process_status varchar(20) not null default 'PENDING';
alter table gov_documents add column if not exists parsed_summary jsonb not null default '{}'::jsonb;
alter table gov_documents add column if not exists period_label varchar(20);
alter table gov_documents add column if not exists error_message text;

-- CNPJ completo do município: a entidade analisada precisa de um CNPJ de 14
-- dígitos (o cnpj_root tem 8 e serve só para o grupo econômico).
alter table gov_municipalities add column if not exists cnpj char(14);

-- Ganho futuro: quanto o município passaria a reter (receita corrente nova)
-- se o decreto municipal entrar em vigor sobre aquele pagamento. É o número
-- do item 5 do procedimento (o que deixa de sair do caixa do município).
alter table gov_candidates add column if not exists forward_gain_cents bigint not null default 0;

-- O candidato aponta para o pagamento analisado. E a chave da idempotencia:
-- rodar o diagnostico de novo atualiza o candidato em vez de duplicar, e a
-- revisao humana feita sobre ele continua valendo.
alter table gov_candidates add column if not exists payment_id uuid references gov_payments(id);
create unique index if not exists gov_candidates_payment_uq on gov_candidates (organization_id, payment_id) where payment_id is not null;

create index if not exists gov_documents_municipality_idx on gov_documents (municipality_id);
create index if not exists gov_withholdings_payment_idx on gov_withholdings (payment_id);
create index if not exists gov_payments_entity_idx on gov_payments (entity_id);
