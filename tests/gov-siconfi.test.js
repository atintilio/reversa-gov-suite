// Testes do conector publico do Siconfi (DCA do Tesouro Nacional).
// O fetch e stubado: o teste nao depende da rede e valida a extracao das
// contas que interessam (IRRF declarado x compras de servicos a PJ).
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createDb, freshRequire, call, cookieFrom } = require('./helpers');

process.env.SESSION_SECRET = 'teste-session-secret';
process.env.RESET_TOKEN_PEPPER = 'teste-pepper';

let sql; let api; let H; let ingestao;
const SENHA = 'Senha-forte-123';

async function user(email, name, orgId, role) {
  const hash = await bcrypt.hash(SENHA, 4);
  const u = (await sql`insert into users (email, email_normalized, name, password_hash, status) values (${email}, ${email}, ${name}, ${hash}, 'active') returning id`)[0];
  await sql`insert into organization_members (organization_id, user_id, role, status) values (${orgId}, ${u.id}, ${role}, 'active')`;
}
const v1 = (path, opts = {}) => call(api, { ...opts, url: '/api/v1/' + path, query: opts.query || {} });
const J = (r) => JSON.parse(r.body);

let orgA; let admin; let municipioId;

// Amostra da DCA: a receita de IRRF (Anexo I-C) e a despesa com servicos de
// PJ (Anexo I-D), como o Tesouro entrega.
const ITENS_DCA = [
  { exercicio: 2024, instituicao: 'Prefeitura Municipal de Tupaciguara - MG', cod_ibge: 3169604, uf: 'MG', anexo: 'DCA-Anexo I-C', rotulo: 'Padrão', coluna: '31/12/2024', cod_conta: 'RO1.1.1.3.03.0.0', conta: 'Imposto sobre a Renda - Retido na Fonte', valor: 4805550.15 },
  { exercicio: 2024, cod_ibge: 3169604, anexo: 'DCA-Anexo I-C', rotulo: 'Padrão', coluna: '31/12/2024', cod_conta: 'RO1.1.1.3.03.1.0', conta: 'IRRF - Trabalho', valor: 4393330.73 },
  { exercicio: 2024, cod_ibge: 3169604, anexo: 'DCA-Anexo I-C', rotulo: 'Padrão', coluna: '31/12/2024', cod_conta: 'RO1.1.1.3.03.4.0', conta: 'IRRF - Outros', valor: 412219.42 },
  { exercicio: 2024, cod_ibge: 3169604, anexo: 'DCA-Anexo I-D', rotulo: 'Padrão', coluna: 'Despesas Empenhadas', cod_conta: 'DO3.3.90.39.00.00', conta: 'Outros Serviços de Terceiros - Pessoa Jurídica', valor: 28860456 },
  { exercicio: 2024, cod_ibge: 3169604, anexo: 'DCA-Anexo I-D', rotulo: 'Padrão', coluna: 'Despesas Empenhadas', cod_conta: 'DO3.3.90.35.00.00', conta: 'Serviços de Consultoria', valor: 614876.4 },
  { exercicio: 2024, cod_ibge: 3169604, anexo: 'DCA-Anexo I-AB', rotulo: 'Padrão', coluna: '31/12/2024', cod_conta: 'P1.0.0.0.0.00.00', conta: 'Ativo', valor: 104910449.91 },
];

test.before(async () => {
  ({ sql } = await createDb());
  freshRequire('lib/db').setSqlForTests(sql);
  api = freshRequire('api/v1/[...route]');
  H = { login: freshRequire('api/login') };
  ingestao = freshRequire('lib/domain/gov-ingestao');
  orgA = (await sql`select id from organizations order by created_at limit 1`)[0].id;
  await user('sic.admin@argus.com', 'Admin Siconfi', orgA, 'admin');
  admin = cookieFrom(await call(H.login, { method: 'POST', body: { usuario: 'sic.admin@argus.com', senha: SENHA } }));
  municipioId = J(await v1('gov/municipios', {
    method: 'POST', cookie: admin,
    body: { ibgeCode: '3169604', name: 'Tupaciguara', state: 'MG', cnpj: '18260489000104' },
  })).id;

  // Stub do fetch: o cliente do Siconfi chama a API de dados abertos.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.indexOf('/dca') >= 0) {
      return { ok: true, status: 200, json: async () => ({ items: ITENS_DCA, count: ITENS_DCA.length, hasMore: false }) };
    }
    throw new Error('URL inesperada no teste: ' + u);
  };
});

test('a busca no Siconfi lê a DCA e grava as contas relevantes', async () => {
  const r = await v1('gov/siconfi/buscar', { method: 'POST', cookie: admin, body: { municipalityId: municipioId, ano: 2024 } });
  assert.equal(r.statusCode, 200, r.body);
  const out = J(r);
  assert.equal(out.ano, 2024);
  assert.equal(out.irrfRetidoOutrosCents, 41221942, 'IRRF - Outros: R$ 412.219,42');
  assert.equal(out.irrfTotalCents, 480555015);
  assert.equal(out.contas.length, 5, 'as cinco contas de interesse');

  const lanc = await sql`select count(*)::int n from gov_accounting_entries where account_code = 'RO1.1.1.3.03.4.0'`;
  assert.equal(lanc[0].n, 1, 'a receita de IRRF entra como credito');
  const desp = await sql`select debit_cents, credit_cents from gov_accounting_entries where account_code = 'DO3.3.90.39.00.00'`;
  assert.equal(Number(desp[0].debit_cents), 2886045600, 'a despesa entra como debito');
  assert.equal(Number(desp[0].credit_cents), 0);

  const decl = await sql`select declared_amount_cents, destination_status from gov_declarations where system_name = 'Siconfi DCA'`;
  assert.equal(decl.length, 1);
  assert.equal(Number(decl[0].declared_amount_cents), 41221942);
  assert.equal(decl[0].destination_status, 'SENT_TO_DCTFWEB', 'a retencao do municipio e declarada na EFD-Reinf (MAFON, codigo 6256)');
});

test('a triagem pública mostra a taxa observada e o sinal de lacuna', async () => {
  const r = await v1('gov/tela-publica', { cookie: admin });
  assert.equal(r.statusCode, 200, r.body);
  const tela = J(r).tela[0];
  assert.equal(tela.municipio, 'Tupaciguara');
  assert.equal(tela.serie.length, 1);
  const ano = tela.serie[0];
  assert.equal(ano.ano, 2024);
  assert.equal(ano.irrfRetidoCents, 41221942);
  assert.equal(ano.comprasCents, 2886045600);
  // 412.219,42 / 28.860.456,00 = 1,4284%
  assert.ok(Math.abs(ano.taxaObservada - 0.0142839) < 0.00001, 'taxa observada: ' + ano.taxaObservada);
  assert.equal(ano.sinalLacuna, 'na-faixa', '1,43% esta dentro da faixa de 1,2% a 4,8%');
  assert.ok(tela.observacao.includes('sinal'), 'a triagem vem rotulada como sinal');
});

test('a DCA consultada entra na lista de documentos como fonte pública', async () => {
  const lista = J(await v1('gov/documentos', { cookie: admin }));
  const doc = lista.documentos.find((d) => d.parserKind === 'siconfi');
  assert.ok(doc, 'o documento do Siconfi aparece na lista');
  assert.equal(doc.classification, 'public');
  assert.ok(doc.name.includes('Siconfi-DCA-3169604-2024'), doc.name);
});

test('outra organização não enxerga a DCA consultada', async () => {
  const outro = (await sql`insert into organizations (name) values ('Org Siconfi') returning id`)[0].id;
  await user('sic.bia@outra.com', 'Bia', outro, 'admin');
  const cookie = cookieFrom(await call(H.login, { method: 'POST', body: { usuario: 'sic.bia@outra.com', senha: SENHA } }));
  const lista = J(await v1('gov/documentos', { cookie }));
  assert.equal(lista.documentos.filter((d) => d.parserKind === 'siconfi').length, 0);
  const tela = await v1('gov/tela-publica', { cookie });
  assert.equal(tela.statusCode, 404, 'sem município na outra organização, a triagem não devolve nada');
});
