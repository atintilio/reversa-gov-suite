// Acesso por suite e passagem de sessao entre suites (suite de destino).
//
// Uma suite e um produto dentro da plataforma (hoje: 'tax' e 'gov'). Quem entra
// em cada suite e concedido pelos admins da organizacao, na tela de Usuarios.
// O acesso vive na tabela suite_access (migration 016).
//
// A passagem de sessao (handoff) resolve o login unico: o Reversa assina um
// token curto com os dados do membro e redireciona para a suite destino, que
// valida a assinatura e cria a sessao la. Sem senha de novo.
const crypto = require('node:crypto');

const SUITES = ['tax', 'gov'];
const SUITE_LABEL = { tax: 'Reversa Tax', gov: 'Reversa Gov' };
const TTL_SEGUNDOS = 60;

function segredoSuite() {
  const s = process.env.SUITE_HMAC_SECRET || process.env.REVERSA_SECRET || process.env.SESSION_SECRET;
  if (!s) throw new Error('SUITE_HMAC_SECRET_NOT_CONFIGURED');
  return s;
}

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

// Os segredos candidatos, na ordem de preferencia. A suite de origem e a de
// destino sao ambientes separados e cada uma tem o seu conjunto de variaveis;
// a passagem so funciona se as duas compartilharem UM deles.
const CHAVES_SEGREDO = ['SUITE_HMAC_SECRET', 'REVERSA_SECRET', 'SESSION_SECRET'];

function segredosSuite() {
  const lista = [];
  for (const chave of CHAVES_SEGREDO) {
    const v = process.env[chave];
    if (v && !lista.includes(v)) lista.push(v);
  }
  return lista;
}

function assinarSuiteToken(payload, segredo) {
  const corpo = b64url(JSON.stringify(payload));
  const assinatura = b64url(crypto.createHmac('sha256', segredo).update(corpo).digest());
  return `v1.${corpo}.${assinatura}`;
}

// Verificacao do token de passagem: confere assinatura e validade. Serve para
// a suite destino, que nao compartilha banco com a origem.
function verificarSuiteToken(token, segredo) {
  if (typeof token !== 'string') return null;
  const partes = token.split('.');
  if (partes.length !== 3 || partes[0] !== 'v1') return null;
  const [, corpo, assinatura] = partes;
  const esperada = b64url(crypto.createHmac('sha256', segredo).update(corpo).digest());
  const a = Buffer.from(assinatura);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload.x !== 'number' || payload.x * 1000 < Date.now()) return null;
  return payload;
}

// Suites de um membro. A sessao legada (transicao, sem usuario no banco)
// mantem acesso integral: e o administrador da plataforma.
async function suitesDoUsuario(sql, organizationId, userId) {
  if (!userId) return SUITES.slice();
  const rows = await sql`
    select suite from suite_access
    where organization_id = ${organizationId} and user_id = ${userId}
    order by suite`;
  const granted = rows.map((r) => r.suite).filter((s) => SUITES.includes(s));
  // Sem registro de suite: o vinculo com a organizacao ja garante o acesso a
  // suite Tax (comportamento anterior a 016). O acesso a suite Gov e sempre
  // concessao explicita.
  return granted.length ? granted : ['tax'];
}

// Substitui as suites de um membro. Sempre preserva 'tax' para quem tem
// papel na organizacao: acesso a suite Tax e a base do produto.
async function definirSuites(sql, organizationId, userId, suites, actorUserId) {
  // Tax e a suite base: e sempre mantida. As demais sao concessao do admin.
  const alvo = SUITES.filter((s) => Array.isArray(suites) && suites.includes(s));
  const existentes = await sql`
    select suite from suite_access
    where organization_id = ${organizationId} and user_id = ${userId}`;
  const atuais = existentes.map((r) => r.suite);
  const copiar = alvo.includes('tax') ? alvo : ['tax'].concat(alvo);
  for (const suite of copiar) {
    if (!atuais.includes(suite)) {
      await sql`
        insert into suite_access (organization_id, user_id, suite, granted_by)
        values (${organizationId}, ${userId}, ${suite}, ${actorUserId || null})
        on conflict (organization_id, user_id, suite) do nothing`;
    }
  }
  for (const suite of atuais) {
    if (!copiar.includes(suite)) {
      await sql`
        delete from suite_access
        where organization_id = ${organizationId} and user_id = ${userId} and suite = ${suite}`;
    }
  }
  return suitesDoUsuario(sql, organizationId, userId);
}

// Verifica o token contra qualquer um dos segredos candidatos do ambiente.
function verificarSuiteTokenComQualquer(token) {
  for (const segredo of segredosSuite()) {
    const payload = verificarSuiteToken(token, segredo);
    if (payload) return payload;
  }
  return null;
}

module.exports = {
  SUITES, SUITE_LABEL, TTL_SEGUNDOS,
  suitesDoUsuario, definirSuites, assinarSuiteToken, verificarSuiteToken, segredoSuite,
  segredosSuite, verificarSuiteTokenComQualquer, CHAVES_SEGREDO,
};
