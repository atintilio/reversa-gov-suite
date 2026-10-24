// Entrada por passagem de sessao na suite do Gov: o token assinado pelo Reversa
// cria o usuario, o vinculo e a sessao local — sem senha de novo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb, freshRequire, call } = require('./helpers');

process.env.SESSION_SECRET = 'teste-session-secret';
process.env.RESET_TOKEN_PEPPER = 'teste-pepper';
process.env.SUITE_HMAC_SECRET = 'teste-suite-hmac';

let sql; let entrar;
const { assinarSuiteToken } = require('../lib/suites');

function tokenValido(extra) {
  return assinarSuiteToken(Object.assign({
    u: '11111111-1111-4111-8111-111111111111',
    e: 'prefeito@municipio.gov.br',
    n: 'Prefeito do Município',
    o: '22222222-2222-4222-8222-222222222222',
    g: 'Prefeitura de Florianópolis',
    r: 'analyst',
    x: Math.floor(Date.now() / 1000) + 60,
  }, extra || {}), process.env.SUITE_HMAC_SECRET);
}

test.before(async () => {
  ({ sql } = await createDb());
  freshRequire('lib/db').setSqlForTests(sql);
  entrar = freshRequire('api/entrar');
});

const chamar = (url) => new Promise((resolve) => {
  const res = {
    statusCode: 200, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b ? String(b) : ''; resolve(this); }
  };
  // no runtime da Vercel req.query vem preenchido a partir da URL
  const parsed = new URL(url, 'http://test.local');
  entrar({ method: 'GET', url, query: Object.fromEntries(parsed.searchParams), headers: {} }, res);
});

test('token invalido devolve 401', async () => {
  const r = await chamar('/entrar?token=invalido');
  assert.equal(r.statusCode, 401);
  assert.equal(JSON.parse(r.body).error.code, 'TOKEN_INVALID');
});

test('token expirado devolve 401', async () => {
  const token = tokenValido({ x: Math.floor(Date.now() / 1000) - 5 });
  const r = await chamar('/entrar?token=' + encodeURIComponent(token));
  assert.equal(r.statusCode, 401);
});

test('token valido cria usuario, vinculo e sessao local', async () => {
  const token = tokenValido();
  const r = await chamar('/entrar?token=' + encodeURIComponent(token));
  assert.equal(r.statusCode, 303);
  assert.equal(r.headers.location, '/gov.html');
  assert.ok(r.headers['set-cookie'], 'deve gravar o cookie de sessao');
  assert.ok(/rv_sessao=/.test(r.headers['set-cookie']));

  const [u] = await sql`select id, email, name, status from users where email_normalized = 'prefeito@municipio.gov.br'`;
  assert.ok(u, 'o usuario deveria existir');
  assert.equal(u.id, '11111111-1111-4111-8111-111111111111', 'o id vem da suite de origem');
  assert.equal(u.status, 'active');

  const [m] = await sql`select role, status from organization_members where user_id = ${u.id}`;
  assert.equal(m.role, 'analyst');
  assert.equal(m.status, 'active');

  const [sa] = await sql`select suite from suite_access where user_id = ${u.id}`;
  assert.equal(sa.suite, 'gov');

  const sessoes = await sql`select count(*)::int n from auth_sessions where user_id = ${u.id}`;
  assert.equal(sessoes[0].n, 1, 'a sessao local foi criada');
});

test('o token nao e aceito por outra suite (segredo diferente)', async () => {
  const token = assinarSuiteToken({ u: '33333333-3333-4333-8333-333333333333', o: '22222222-2222-4222-8222-222222222222', x: Math.floor(Date.now() / 1000) + 60 }, 'segredo-errado');
  const r = await chamar('/entrar?token=' + encodeURIComponent(token));
  assert.equal(r.statusCode, 401);
});

test('a sessao criada pelo handoff e aceita pelo runtime', async () => {
  const token = tokenValido({ e: 'outro@municipio.gov.br', u: '44444444-4444-4444-8444-444444444444' });
  const r = await chamar('/entrar?token=' + encodeURIComponent(token));
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  const { currentUser } = require('../lib/auth');
  const user = await currentUser({ headers: { cookie } });
  assert.ok(user, 'a sessao deveria ser valida');
  assert.equal(user.email, 'outro@municipio.gov.br');
});
