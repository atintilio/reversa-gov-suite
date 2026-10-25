// Testes da configuracao de suite lida do banco (suite_config).
//
// A integracao entre as suites (handoff de sessao e diagnostico
// previdenciario server-to-server) depende de duas coisas: a URL da suite de
// destino e o segredo compartilhado. Estas normalmente vem de variaveis de
// ambiente; quando o ambiente nao pode ser mudado no deploy, ficam na
// tabela suite_config do banco.
//
// O que se verifica aqui: a precedencia (ambiente > banco), a leitura do
// banco, e que o token assinado com o segredo do banco e aceito na
// verificacao.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb, freshRequire, call } = require('./helpers');

process.env.SESSION_SECRET = 'teste-session-secret';
process.env.SUITE_HMAC_SECRET = 'teste-suite-hmac';

let sql; let suites;

test.before(async () => {
  ({ sql } = await createDb());
  freshRequire('lib/db').setSqlForTests(sql);
  suites = freshRequire('lib/suites');
});

test.after(() => { delete process.env.SUITE_SHARED_SECRET; });

const semear = async (chave, valor) => {
  await sql`
    insert into suite_config (key, value) values (${chave}, ${valor})
    on conflict (key) do update set value = excluded.value`;
};

test('a URL da suite vem do banco quando nao ha variavel de ambiente', async () => {
  await semear('suite.url_gov', 'https://gov.exemplo.test');
  assert.equal(await suites.urlSuite('gov'), 'https://gov.exemplo.test');
});

test('a variavel de ambiente tem precedencia sobre o banco', async () => {
  await semear('suite.url_gov', 'https://gov.exemplo.test');
  process.env.SUITE_URL_GOV = 'https://gov.da-variavel.test';
  try {
    assert.equal(await suites.urlSuite('gov'), 'https://gov.da-variavel.test');
  } finally {
    delete process.env.SUITE_URL_GOV;
  }
});

test('o segredo compartilhado vem do banco', async () => {
  await semear('suite.secret_compartilhado', 'segredo-do-banco');
  assert.equal(await suites.segredoSuiteCompartilhado(), 'segredo-do-banco');
});

test('a variavel SUITE_SHARED_SECRET tem precedencia sobre o banco', async () => {
  await semear('suite.secret_compartilhado', 'segredo-do-banco');
  process.env.SUITE_SHARED_SECRET = 'segredo-da-variavel';
  try {
    assert.equal(await suites.segredoSuiteCompartilhado(), 'segredo-da-variavel');
  } finally {
    delete process.env.SUITE_SHARED_SECRET;
  }
});

test('sem config no banco, cai na cadeia legada de variaveis de ambiente', async () => {
  await sql`delete from suite_config where key = 'suite.secret_compartilhado'`;
  assert.equal(await suites.segredoSuiteCompartilhado(), 'teste-suite-hmac');
});

test('token assinado com o segredo do banco e aceito na verificacao', async () => {
  await semear('suite.secret_compartilhado', 'segredo-do-banco');
  const token = suites.assinarSuiteToken(
    { u: 'x', o: 'org', x: Math.floor(Date.now() / 1000) + 60 },
    'segredo-do-banco'
  );
  const segredos = await suites.segredosSuiteCompartilhados();
  const payload = suites.verificarSuiteTokenDaLista(token, segredos);
  assert.ok(payload, 'o token do banco deveria ser aceito');
  assert.equal(payload.u, 'x');
});

test('token de segredo desconhecido continua recusado', async () => {
  await semear('suite.secret_compartilhado', 'segredo-do-banco');
  const token = suites.assinarSuiteToken(
    { u: 'x', o: 'org', x: Math.floor(Date.now() / 1000) + 60 },
    'segredo-errado'
  );
  const segredos = await suites.segredosSuiteCompartilhados();
  assert.equal(suites.verificarSuiteTokenDaLista(token, segredos), null);
});

test('a tabela suite_config existe com a chave como primary key', async () => {
  const cols = await sql`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'suite_config'`;
  const nomes = cols.map((c) => c.column_name);
  assert.ok(nomes.includes('key'));
  assert.ok(nomes.includes('value'));
});
