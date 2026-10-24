// Prova que db/schema-completo-seguro.sql nao altera nem apaga nada do que ja
// esta no banco: aplica duas vezes num banco que ja tem dados e compara antes/depois.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { splitStatements } = require('../scripts/migrate');

const ARQUIVO = path.join(__dirname, '..', 'db', 'schema-completo-seguro.sql');

// PGlite devolve as linhas direto quando nao ha parametros e um objeto Results quando ha.
const linhas = (r) => (Array.isArray(r) ? r : r.rows);

async function aplicar(db) {
  const bruto = fs.readFileSync(ARQUIVO, 'utf8');
  // unica adaptacao do ambiente de teste: PGlite nao tem a extensao pgcrypto
  const comandos = splitStatements(bruto).filter((c) => !/^(\s*--[^\n]*\n)*\s*create extension/i.test(c));
  for (const comando of comandos) await db.query(comando);
}

const estado = async (db) => ({
  org: linhas(await db.query('select name, kind from organizations'))[0],
  user: linhas(await db.query('select email_normalized, name from users'))[0],
  municipios: linhas(await db.query('select count(*)::int n from gov_municipalities'))[0].n,
  entidades: linhas(await db.query('select count(*)::int n from gov_entities'))[0].n,
  constraints: linhas(await db.query(`select conname from pg_constraint where conrelid in ('gov_municipalities'::regclass,'gov_entities'::regclass) order by conname`)).map((r) => r.conname),
});

test('o schema seguro e idempotente e nao mexe em dado existente', async () => {
  const db = await PGlite.create();
  try {
    await aplicar(db);

    // um dono, uma organizacao e dados do modulo Gov
    const [org] = linhas(await db.query(`insert into organizations (name, kind) values ('Argus Prime', 'interna') returning id`));
    await db.query(`insert into users (email, email_normalized, name, password_hash, status)
      values ('atintilio@argusprime.com.br', 'atintilio@argusprime.com.br', 'Administrador Argus Prime', 'x', 'active')`);
    const [mun] = linhas(await db.query(`insert into gov_municipalities (organization_id, ibge_code, name, state)
      values ($1, '4205402', 'Florianópolis', 'SC') returning id`, [org.id]));
    await db.query(`insert into gov_entities (organization_id, municipality_id, cnpj, legal_name, entity_type)
      values ($1, $2, '11222333000181', 'Prefeitura', 'direct_admin')`, [org.id, mun.id]);

    const antes = await estado(db);

    // segunda aplicacao: e o que acontece se voce colar o arquivo de novo
    await aplicar(db);
    const depois = await estado(db);

    assert.deepEqual(depois, antes, 'o schema seguro nao pode mudar nada');
    assert.equal(depois.org.kind, 'interna', 'a organizacao nao pode virar plataforma por baixo dos panos');
    assert.equal(depois.user.name, 'Administrador Argus Prime', 'o nome do usuario nao pode ser reescrito');
    assert.equal(depois.municipios, 1);
    assert.equal(depois.entidades, 1);
  } finally {
    await db.close();
  }
});

test('o schema fiel tem exatamente 2 update e 2 drop constraint — e o seguro remove os 4', () => {
  const fiel = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-completo.sql'), 'utf8');
  const seguro = fs.readFileSync(ARQUIVO, 'utf8');
  const conta = (t, re) => (t.match(re) || []).length;
  assert.equal(conta(fiel, /^\s*update\s+/gim), 2);
  assert.equal(conta(fiel, /^alter table gov_\w+ drop constraint/gim), 2);
  assert.equal(conta(seguro, /^\s*update\s+/gim), 0);
  assert.equal(conta(seguro, /^alter table gov_\w+ drop constraint/gim), 0);
  assert.equal(conta(seguro, /if \(select count\(\*\) from gov_\w+\) = 0 then/g), 2, 'os drops devem estar guardados por tabela vazia');
});
