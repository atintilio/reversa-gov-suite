-- 018 — vinculo do candidato com o pagamento analisado.
-- E a chave da idempotencia do diagnostico: rodar de novo atualiza o
-- candidato em vez de duplicar, e a revisao humana feita sobre ele
-- continua valendo. Aditivo: nenhuma tabela e recriada.
alter table gov_candidates add column if not exists payment_id uuid references gov_payments(id);

create unique index if not exists gov_candidates_payment_uq
  on gov_candidates (organization_id, payment_id) where payment_id is not null;
