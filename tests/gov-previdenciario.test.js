// Testes da revisão previdenciária: a folha entra no Gov, o Gov chama o
// Reversa Tax, e o que volta fica guardado no Gov.
//
// O Tax é simulado no limite da rede (fetch): o que se verifica aqui é o
// contrato entre as suites e a gravação do resultado. O cálculo em si é do
// motor, testado no repositório do Tax (motor-esocial.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createDb, freshRequire, call, cookieFrom } = require('./helpers');

process.env.SESSION_SECRET = 'teste-session-secret';
process.env.RESET_TOKEN_PEPPER = 'teste-pepper';
process.env.SUITE_HMAC_SECRET = 'teste-suite-hmac';
process.env.SUITE_URL_TAX = 'https://reversa-tax.exemplo.vercel.app';

let sql; let api; let H;
const SENHA = 'Senha-forte-123';

async function user(email, name, orgId, role) {
  const hash = await bcrypt.hash(SENHA, 4);
  const u = (await sql`insert into users (email, email_normalized, name, password_hash, status) values (${email}, ${email}, ${name}, ${hash}, 'active') returning id`)[0];
  if (orgId) await sql`insert into organization_members (organization_id, user_id, role, status) values (${orgId}, ${u.id}, ${role}, 'active')`;
  return u.id;
}
async function login(email) {
  return cookieFrom(await call(H.login, { method: 'POST', body: { usuario: email, senha: SENHA } }));
}
const v1 = (path, opts = {}) => call(api, { ...opts, url: '/api/v1/' + path, query: opts.query || {} });
const J = (r) => JSON.parse(r.body);

let orgA; let admin; let municipio; let municipioSemFolha;

const XML_FOLHA = `<?xml version="1.0" encoding="UTF-8"?>
<eSocial xmlns="http://www.esocial.gov.br/es">
  <evtRemun Id="IDREM">
    <ideEvento><indRetif>1</indRetif><indApuracao>1</indApuracao><perApur>2024-01</perApur></ideEvento>
    <ideTrabalhador><cpfTrab>12345678909</cpfTrab></ideTrabalhador>
    <dmDev><ideDmDev>1</ideDmDev><codCateg>101</codCateg><infoPerApur>
      <ideEstabLot><tpInsc>1</tpInsc><nrInsc>18260489000190</nrInsc><codLotacao>L1</codLotacao>
        <remunPerApur><itensRemun><codRubr>001</codRubr><ideTabRubr>T1</ideTabRubr><vrRubr>5000.00</vrRubr></itensRemun></remunPerApur>
      </ideEstabLot>
    </infoPerApur></dmDev>
  </evtRemun>
</eSocial>`;

// Resposta do Reversa Tax, no contrato definido pelo Tax.
const RESPOSTA_TAX = {
  ok: true,
  motor: { versao: '0.5.0', versaoExtra: '1.0.0' },
  escopo: { ok: true, classTrib: '99' },
  total: { valorCents: 129000, valorNoPrazoCents: 129000 },
  teses: [
    { id: 'T006', nome: 'Contribuição previdenciária sobre primeiros 15 dias de afastamento', baseCents: 200000, baseNoPrazoCents: 200000, valorCents: 129000, valorNoPrazoCents: 129000, competencias: 1, condicional: false },
  ],
  avisos: ['Faltam os eventos S-1005 (estabelecimentos): o RAT ajustado pelo FAP não foi aplicado.'],
  requerDocumento: [],
  dependencias: [],
  pagamento: 'nao-confirmado',
  rubricasAnalisadas: 1,
  lidos: 1,
  ignorados: [],
  ressalva: 'Valores estimados pelo motor previdenciário. Pagamento não confirmado (GFIP/DCTFWeb/DARF) e valores não atualizados pela Selic. Revisão humana obrigatória antes de qualquer lançamento.',
};

let chamadas = [];

test.before(async () => {
  ({ sql } = await createDb());
  freshRequire('lib/db').setSqlForTests(sql);
  api = freshRequire('api/v1/[...route]');
  H = { login: freshRequire('api/login') };
  orgA = (await sql`select id from organizations order by created_at limit 1`)[0].id;
  await user('prev.admin@argus.com', 'Admin Prev', orgA, 'admin');
  admin = await login('prev.admin@argus.com');
  const [mun] = await sql`
    insert into gov_municipalities (organization_id, ibge_code, name, state, cnpj_root)
    values (${orgA}, '3169604', 'Tupaciguara', 'MG', '18260489') returning id`;
  municipio = mun.id;
  const [vazio] = await sql`
    insert into gov_municipalities (organization_id, ibge_code, name, state, cnpj_root)
    values (${orgA}, '3169605', 'Municipio Sem Folha', 'MG', '18260490') returning id`;
  municipioSemFolha = vazio.id;
});

test.beforeEach(() => { chamadas = []; });

// Simula a resposta do Reversa Tax no limite da rede.
function comTaxe(responder) {
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    chamadas.push({ url: String(url), headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    const r = responder ? responder(url, opts) : RESPOSTA_TAX;
    return {
      ok: r.status ? r.status < 400 : true,
      status: r.status || 200,
      text: async () => JSON.stringify(r.status && r.status >= 400 ? r : RESPOSTA_TAX),
    };
  };
  return () => { global.fetch = original; };
}

async function enviarFolha() {
  const r = await v1('gov/documentos', {
    method: 'POST', cookie: admin,
    body: { name: 'S-1200-2024-01.xml', municipalityId: municipio, contentBase64: Buffer.from(XML_FOLHA, 'utf8').toString('base64') },
  });
  assert.equal(r.statusCode, 201, 'o documento foi aceito: ' + r.body);
  const doc = J(r);
  const p = await v1('gov/documentos/' + doc.id, { method: 'POST', cookie: admin });
  assert.equal(p.statusCode, 200, 'o documento foi processado: ' + p.body);
  return doc.id;
}

test('a folha do eSocial entra no Gov e e reconhecida como folha', async () => {
  const id = await enviarFolha();
  const [doc] = await sql`select parser_kind, process_status, parsed_summary from gov_documents where id = ${id}::uuid`;
  assert.equal(doc.parser_kind, 'esocial');
  assert.equal(doc.process_status, 'PARSED');
  assert.deepEqual(doc.parsed_summary.competencias, ['2024-01']);
});

test('sem folha a revisao explica o que falta', async () => {
  const restaura = comTaxe();
  try {
    const r = await v1('gov/previdenciario', { method: 'POST', cookie: admin, body: { municipalityId: municipioSemFolha } });
    assert.equal(r.statusCode, 400);
    assert.equal(J(r).error.code, 'NO_FOLHA');
    assert.equal(chamadas.length, 0, 'sem folha nao ha o que enviar');
  } finally { restaura(); }
});

test('a revisao chama o Tax com token de suite e guarda o que volta', async () => {
  await enviarFolha();
  const restaura = comTaxe();
  try {
    const r = await v1('gov/previdenciario', { method: 'POST', cookie: admin, body: { municipalityId: municipio } });
    assert.equal(r.statusCode, 200, r.body);
    const d = J(r);
    assert.equal(d.status, 'OK');
    assert.equal(d.teses.length, 1);
    assert.equal(d.teses[0].id, 'T006');
    assert.equal(d.teses[0].valorCents, 129000);
    assert.equal(d.total.valorCents, 129000);
    assert.ok(d.ressalva.includes('estimad'));

    // A chamada saiu assinada para a URL do Tax.
    assert.equal(chamadas.length, 1);
    assert.ok(chamadas[0].url.startsWith('https://reversa-tax.exemplo.vercel.app/api/v1/previdenciario/diagnostico'));
    const token = chamadas[0].headers['x-reversa-suite-token'];
    assert.ok(token && token.startsWith('v1.'), 'a chamada vai com token de suite');
    // O corpo leva a folha como o municipio enviou.
    assert.ok(chamadas[0].body.arquivos.length >= 1, 'a folha vai no corpo da chamada');
    assert.ok(chamadas[0].body.arquivos[0].contentBase64, 'o arquivo vai inteiro');
  } finally { restaura(); }
});

test('as teses ficam gravadas no Gov, ligadas ao run', async () => {
  await enviarFolha();
  const restaura = comTaxe();
  try {
    const r = await v1('gov/previdenciario', { method: 'POST', cookie: admin, body: { municipalityId: municipio } });
    const d = J(r);
    const [run] = await sql`select * from gov_previdenciario_runs where id = ${d.runId}::uuid`;
    assert.ok(run, 'o run foi gravado');
    assert.equal(run.status, 'OK');
    assert.equal(run.engine_version, '0.5.0');
    assert.equal(Number(run.total_cents), 129000);
    const teses = await sql`select * from gov_previdenciario_teses where run_id = ${d.runId}::uuid`;
    assert.equal(teses.length, 1);
    assert.equal(teses[0].tese_id, 'T006');
    assert.equal(Number(teses[0].valor_cents), 129000);
    assert.equal(teses[0].status, 'DRAFT', 'nada entra validado sem revisão humana');
  } finally { restaura(); }
});

test('o painel devolve a ultima revisao com a ressalva', async () => {
  const r = await v1('gov/previdenciario', { method: 'GET', cookie: admin, query: { municipalityId: municipio } });
  assert.equal(r.statusCode, 200);
  const d = J(r);
  assert.ok(d.run, 'ha um run');
  assert.equal(d.run.status, 'OK');
  assert.equal(d.teses.length, 1);
  assert.ok(d.ressalva.toLowerCase().includes('revisão humana obrigatória'));
  assert.ok(d.documentos.length >= 1, 'a folha enviada aparece na lista');
  assert.ok(d.historico.length >= 1);
});

test('quando o Tax recusa a folha, o Gov repassa o erro com o codigo', async () => {
  await enviarFolha();
  const restaura = comTaxe(() => ({ status: 422, error: { code: 'NO_VALID_FILES', message: 'Nenhum XML de folha válido.' } }));
  try {
    const r = await v1('gov/previdenciario', { method: 'POST', cookie: admin, body: { municipalityId: municipio } });
    assert.equal(r.statusCode, 422);
    assert.equal(J(r).error.code, 'NO_VALID_FILES');
    const [run] = await sql`select * from gov_previdenciario_runs order by created_at desc limit 1`;
    assert.equal(run.status, 'ERROR', 'a chamada falha fica registrada como erro');
    assert.ok(run.erro);
  } finally { restaura(); }
});

test('sem sessao a revisao e barrada', async () => {
  const r = await v1('gov/previdenciario', { method: 'POST', body: { municipalityId: municipio } });
  assert.equal(r.statusCode, 401);
});
