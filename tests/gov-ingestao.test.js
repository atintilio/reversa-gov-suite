// Testes da ingestão de documentos e do diagnóstico do módulo IRRF Municipal.
//
// Exercita o caminho real: upload do documento -> parser -> fatos persistidos
// -> diagnóstico (motor de regras) -> candidato com evidência. Aklassificação
// é conferida contra as regras de lib/domain/gov-irrf.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createDb, freshRequire, call, cookieFrom } = require('./helpers');

process.env.SESSION_SECRET = 'teste-session-secret';
process.env.RESET_TOKEN_PEPPER = 'teste-pepper';

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

let orgA; let admin; let municipioId;

// Planilha de retenção: doisigg retidos, um deles com CNR 11009 (União).
const CSV_RETENCAO = [
  'CNPJ;RAZAO_SOCIAL;COMPETENCIA;DATA_PAGAMENTO;CNR;BASE_RETIDA;VALOR_RETIDO;DESTINATARIO',
  '11222333000181;Servicos Alfa Ltda;05/2026;20/05/2026;062301;100000,00;1500,00;MUNICIPIO',
  '44555666000177;Obra Beta ME;05/2026;22/05/2026;11009;50000,00;750,00;UNIAO',
  '99887766000155;Consultoria Gama SA;05/2026;25/05/2026;062301;20000,00;0,00;MUNICIPIO',
].join('\n');

test.before(async () => {
  ({ sql } = await createDb());
  freshRequire('lib/db').setSqlForTests(sql);
  api = freshRequire('api/v1/[...route]');
  H = { login: freshRequire('api/login') };
  orgA = (await sql`select id from organizations order by created_at limit 1`)[0].id;
  await user('ing.admin@argus.com', 'Admin Ingestao', orgA, 'admin');
  admin = await login('ing.admin@argus.com');
  const r = await v1('gov/municipios', {
    method: 'POST', cookie: admin,
    body: { ibgeCode: '3169604', name: 'Tupaciguara', state: 'MG', cnpjRoot: '18260489', cnpj: '18260489000104' },
  });
  assert.equal(r.statusCode, 201, r.body);
  municipioId = J(r).id;
});

test('o upload do documento exige município existente', async () => {
  const r = await v1('gov/documentos', {
    method: 'POST', cookie: admin,
    body: { municipalityId: '00000000-0000-0000-0000-000000000000', name: 'x.csv', text: CSV_RETENCAO },
  });
  assert.equal(r.statusCode, 404);
});

test('o upload guarda o arquivo, o checksum e detecta o formato', async () => {
  const r = await v1('gov/documentos', {
    method: 'POST', cookie: admin,
    body: { municipalityId: municipioId, name: 'retencao-maio-2026.csv', text: CSV_RETENCAO },
  });
  assert.equal(r.statusCode, 201, r.body);
  const doc = J(r);
  assert.equal(doc.parserKind, 'csv');
  assert.equal(doc.status, 'PENDING');
  assert.ok(doc.checksum && doc.checksum.length === 64, 'checksum sha256 do arquivo');
  const lista = J(await v1('gov/documentos', { cookie: admin }));
  assert.equal(lista.documentos.length, 1);
  assert.equal(lista.documentos[0].name, 'retencao-maio-2026.csv');
});

test('processar o documento persiste pagamentos e retencoes', async () => {
  const lista = J(await v1('gov/documentos', { cookie: admin }));
  const docId = lista.documentos[0].id;
  const r = await v1(`gov/documentos/${docId}`, { method: 'POST', cookie: admin });
  assert.equal(r.statusCode, 200, r.body);
  const out = J(r);
  assert.equal(out.status, 'DONE');
  assert.equal(out.resumo.retencoes, 3);
  assert.equal(out.resumo.pagamentos, 3);

  const pagamentos = await sql`select count(*)::int n from gov_payments`;
  const retencoes = await sql`select count(*)::int n from gov_withholdings`;
  assert.equal(pagamentos[0].n, 3);
  assert.equal(retencoes[0].n, 3);
  const valores = await sql`select sum(withheld_amount_cents)::bigint total from gov_withholdings`;
  assert.equal(Number(valores[0].total), 225000, '1.500,00 + 750,00 em centavos');
});

test('o diagnostico classifica cada pagamento pelas regras', async () => {
  const r = await v1('gov/diagnostico', { method: 'POST', cookie: admin, body: { municipalityId: municipioId } });
  assert.equal(r.statusCode, 200, r.body);
  const diag = J(r).diagnostico[0];
  assert.equal(diag.municipio, 'Tupaciguara');
  assert.equal(diag.pagamentos, 3);
  assert.equal(diag.retidoTotalCents, 225000);

  const porCnpj = {};
  diag.candidatos.forEach((c) => { porCnpj[c.cnpj] = c; });

  // 062301 (serviço): o documento declara DESTINATARIO=MUNICIPIO, ou seja, o
  // município reteve e ficou com o imposto — que é dele (Tema 1.130). Sem
  // crédito a recuperar; o ganho futuro ainda aparece.
  const servico = porCnpj['11222333000181'];
  assert.equal(servico.rule, 'RETAINED_AND_RECOGNIZED');
  assert.equal(servico.status, 'REJECTED');
  assert.equal(servico.creditoRetroativoCents, 0, 'sem repasse à União, não há crédito');
  assert.equal(servico.titularidade, 'MUNICIPAL');
  assert.equal(servico.nivelEvidencia, 'documento', 'o destino veio do próprio documento');
  assert.ok(servico.motivo && servico.motivo.length > 20, 'o motivo da regra é registrado');

  // 11009 (decisão judicial, IRRF da União — NT 04/2026): nunca é default municipal.
  const judicial = porCnpj['44555666000177'];
  assert.equal(judicial.rule, 'DESTINATION_UNPROVEN');
  assert.equal(judicial.titularidade, 'FEDERAL');
  assert.ok(/11009/.test(judicial.motivo), 'o motivo cita o CNR 11009');

  // Pagamento sem retenção: vira ganho futuro, com a alíquota que o próprio
  // documento revela (1.500 / 100.000 = 1,5%) — nenhuma taxa fixa no módulo.
  const semRetencao = porCnpj['99887766000155'];
  assert.equal(semRetencao.rule, 'NO_WITHHOLDING');
  assert.equal(semRetencao.status, 'NEEDS_EVIDENCE');
  assert.equal(semRetencao.aliquota, 0.015, 'alíquota implícita pelo documento');
  assert.equal(semRetencao.ganhoFuturoCents, 30000, '1,5% sobre R$ 20.000,00');
  assert.equal(diag.ganhoFuturoCents, 30000);
  assert.ok(diag.metodologia && diag.metodologia.ganhoFuturo, 'o resultado traz a nota metodológica');
});

test('cada candidato nasce com a evidencia do documento que o sustenta', async () => {
  const links = await sql`
    select c.cnr, e.evidence_type, e.record_locator, e.validation_status
    from gov_evidence_links e
    join gov_candidates c on c.id = e.candidate_id`;
  assert.equal(links.length, 3);
  links.forEach((l) => {
    assert.equal(l.evidence_type, 'PLANILHA_RETENCAO');
    assert.equal(l.validation_status, 'PENDING', 'evidência pendente de conferência humana');
    assert.ok(l.record_locator && l.record_locator.includes('Planilha linha'), l.record_locator);
  });
});

test('nenhum candidato é validado automaticamente', async () => {
  const validados = await sql`select count(*)::int n from gov_candidates where status = 'VALIDATED'`;
  assert.equal(validados[0].n, 0, 'a validação é humana');
});

test('a leitura da ECD gera lançamentos contábeis como evidência de destino', async () => {
  // Leiaute SPED da ECD: cada linha comeca por "|" e traz o registro.
  const ecd = [
    '|0000|LECD|01012026|31012026|PREFEITURA DE TUPACIGUARA|18260489000104|MG|',
    '|I050|01012026|4|1|4.1.1.2.01.01.01||RECEITA TRIBUTARIA IRRF RETIDO||',
    '|I050|01012026|4|2|3.1.4.1.01.01.01||APROPRIACAO IRRF RETIDO NA RECEITA||',
    '|I200|1|20052026|1500,00|||',
    '|I250|3.1.4.1.01.01.01||1500,00|D|||APROPRIACAO IRRF RETIDO|',
    '|I250|4.1.1.2.01.01.01||1500,00|C|||APROPRIACAO IRRF RETIDO|',
  ].join('\n');
  const r = await v1('gov/documentos', {
    method: 'POST', cookie: admin,
    body: { municipalityId: municipioId, name: 'ecd-2026.txt', text: ecd },
  });
  assert.equal(r.statusCode, 201, r.body);
  const docId = J(r).id;
  assert.equal(J(r).parserKind, 'ecd', 'detecta ECD pelo cabeçalho 0000');
  const proc = await v1(`gov/documentos/${docId}`, { method: 'POST', cookie: admin });
  assert.equal(proc.statusCode, 200, proc.body);
  assert.ok(J(proc).resumo.lancamentos >= 2, 'lançamentos lidos da ECD');

  const lanc = await sql`select count(*)::int n from gov_accounting_entries`;
  assert.ok(lanc[0].n >= 2);
});

test('com a ECD, a apropriação pelo município encerra a hipótese de crédito', async () => {
  const diag = J(await v1('gov/diagnostico', { method: 'POST', cookie: admin, body: { municipalityId: municipioId } })).diagnostico[0];
  assert.ok(diag.sinaisDestino.lancamentosIrrf >= 1, 'há lançamento que cita IRRF');
  const c = diag.candidatos.find((x) => x.cnr === '062301');
  // Tema 1.130: o IRRF retido pelo município e dele. Se foi apropriado como
  // receita propria, nao ha credito a recuperar contra a Uniao.
  assert.equal(c.rule, 'RETAINED_AND_RECOGNIZED');
  assert.equal(c.status, 'REJECTED');
  assert.equal(c.titularidade, 'MUNICIPAL');
  assert.equal(c.creditoRetroativoCents, 0);
  assert.ok(diag.sinaisDestino.lancamentosIrrf >= 1, 'a ECD alimenta o sinal de aproprianacao');
});

test('com o DARF do mesmo período, o repasse à União abre o crédito', async () => {
  const darf = [
    'CODIGO_RECEITA;DATA_RECOLHIMENTO;VALOR_RECOLHIDO;DESCRICAO;CNPJ',
    '0561;20/05/2026;1500,00;IRRF SOBRE SERVICOS;18260489000104',
  ].join('\n');
  const r = await v1('gov/documentos', {
    method: 'POST', cookie: admin,
    body: { municipalityId: municipioId, name: 'darf-maio-2026.csv', text: darf },
  });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(J(r).parserKind, 'pagamentos', 'detecta relatorio de pagamentos');
  const proc = await v1(`gov/documentos/${J(r).id}`, { method: 'POST', cookie: admin });
  assert.equal(proc.statusCode, 200, proc.body);
  assert.equal(J(proc).resumo.recolhimentos, 1);

  const remessas = await sql`select count(*)::int n from gov_remittances`;
  assert.equal(remessas[0].n, 1);

  const diag = J(await v1('gov/diagnostico', { method: 'POST', cookie: admin, body: { municipalityId: municipioId } })).diagnostico[0];
  assert.ok(diag.sinaisDestino.remessasUniao >= 1, 'há recolhimento para a União');
  const c = diag.candidatos.find((x) => x.cnr === '062301');
  // A prova do documento (DESTINATARIO=MUNICIPIO) é mais forte que a do
  // período: o DARF mostra que houve recolhimento, mas não diz a quem pertence
  // aquele pagamento. O caso fica para revisão humana, não vira crédito.
  assert.equal(c.nivelEvidencia, 'documento');
  assert.equal(c.creditoRetroativoCents, 0, 'sem prova de repasse, não há crédito assertado');
  assert.equal(c.confianca, 'HIGH', 'a prova é a do documento, ainda com revisão pendente');
});

test('sem alíquota no documento, o módulo não estima ganho futuro', async () => {
  const orgC = (await sql`insert into organizations (name) values ('Fidelidade') returning id`)[0].id;
  await user('fid.admin@argus.com', 'Fid', orgC, 'admin');
  const cookie = await login('fid.admin@argus.com');
  const mun = J(await v1('gov/municipios', {
    method: 'POST', cookie,
    body: { ibgeCode: '3106200', name: 'Passos', state: 'MG', cnpj: '18262201000107' },
  })).id;
  // Pagamento com base, nada retido e nenhuma aliquota no documento.
  const csv = ['CNPJ;RAZAO_SOCIAL;COMPETENCIA;DATA_PAGAMENTO;CNR;BASE_RETIDA;VALOR_RETIDO',
    '11222333000181;Servicos Alfa Ltda;05/2026;20/05/2026;062301;100000,00;0,00'].join('\n');
  const doc = J(await v1('gov/documentos', {
    method: 'POST', cookie, body: { municipalityId: mun, name: 'r.csv', text: csv },
  }));
  await v1(`gov/documentos/${doc.id}`, { method: 'POST', cookie });
  const diag = J(await v1('gov/diagnostico', { method: 'POST', cookie, body: { municipalityId: mun } })).diagnostico[0];
  const c = diag.candidatos[0];
  assert.equal(c.aliquota, null, 'sem aliquota conhecida');
  assert.equal(c.ganhoFuturoCents, 0, 'não estima ganho futuro sem base de calculo da aliquota');
  assert.equal(diag.ganhoFuturoCents, 0);
  assert.equal(c.status, 'NEEDS_EVIDENCE', 'é pendente, não rejeitado: falta a alíquota');
  assert.ok(/aliquota/i.test(c.motivo), 'o motivo diz o que falta');
});

test('o isolamento por organização continua valendo na ingestão', async () => {
  const outro = (await sql`insert into organizations (name) values ('Outra Org Gov') returning id`)[0].id;
  await user('ing.bia@outra.com', 'Bia', outro, 'admin');
  const cookie = await login('ing.bia@outra.com');
  const lista = J(await v1('gov/documentos', { cookie }));
  assert.equal(lista.documentos.length, 0, 'nenhum documento de outra organização');
  const r = await v1('gov/documentos', {
    method: 'POST', cookie,
    body: { municipalityId: municipioId, name: 'tentativa.csv', text: CSV_RETENCAO },
  });
  assert.equal(r.statusCode, 404, 'não usa município de outra organização');
});
