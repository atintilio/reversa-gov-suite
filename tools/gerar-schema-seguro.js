// Gera db/schema-completo-seguro.sql a partir de db/schema-completo.sql.
//
// O arquivo fiel (schema-completo.sql) reproduz as migrations exatamente como o
// runner de build aplica. A versao segura e para colar em um banco que ja tem
// dados: remove os dois UPDATE (que reescrevem linhas existentes) e troca os
// DROP CONSTRAINT por guarded — so removem a constraint quando a tabela esta
// vazia. Todo o resto e DDL aditivo (create ... if not exists / add column if not exists).
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'db');
const origem = fs.readFileSync(path.join(DIR, 'schema-completo.sql'), 'utf8');

// 1) remove os UPDATE que reescrevem dados existentes
const semUpdate = origem.replace(/^update\s+users\s+set\s+name[\s\S]*?;\s*$/gm, '-- [seguro] update de nome do proprietario omitido: nao altera dados existentes\n')
  .replace(/^update\s+organizations\s+set\s+kind[\s\S]*?;\s*$/gm, '-- [seguro] update de kind da organizacao omitido: nao altera dados existentes\n');

// 2) o DROP CONSTRAINT so acontece se a tabela estiver vazia.
// O bloco fica em uma unica linha: o splitter das migrations quebra em ';'
// seguido de nova linha, e um 'do $$' multilinha viraria SQL invalido.
const guarda = (tabela, constraint) =>
  `do $$ begin if (select count(*) from ${tabela}) = 0 then alter table ${tabela} drop constraint if exists ${constraint}; end if; end $$;`;

// funcao no replacement: em string, '$$' viraria '$' e quebraria o bloco do $$.
const semDrop = semUpdate
  .replace(/^alter table gov_municipalities drop constraint if exists gov_municipalities_ibge_uq;\s*$/m,
    () => guarda('gov_municipalities', 'gov_municipalities_ibge_uq'))
  .replace(/^alter table gov_entities drop constraint if exists gov_entities_cnpj_uq;\s*$/m,
    () => guarda('gov_entities', 'gov_entities_cnpj_uq'));

const cabecalho = `-- Schema seguro da suite Reversa Gov: mesma estrutura, sem tocar em dados.
-- Diferencas em relacao a db/schema-completo.sql:
--   - os 2 UPDATE (nome do proprietario e kind da organizacao) foram removidos
--   - os 2 DROP CONSTRAINT so rodam se a tabela gov_* estiver vazia
-- Todo o restante e DDL aditivo: create ... if not exists e add column if not exists.
-- Pode colar varias vezes: e idempotente.

`;
const destino = path.join(DIR, 'schema-completo-seguro.sql');
fs.writeFileSync(destino, cabecalho + semDrop);
console.log('gerado:', destino, fs.statSync(destino).size, 'bytes');
console.log('update restante:', /^\s*update\s+/im.test(semDrop));
console.log('drop constraint desprotegido:', /^alter table gov_\w+ drop constraint/m.test(semDrop));
