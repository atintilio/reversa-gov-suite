const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const M = require('../diagnostico-amostra');
function amostra() {
  return Array.from({ length: 5 }, (_, i) => [1, 6, 9].map(m => ({ cnpj: '123', tese: 'T', regime: 'Real', competencia: `${2021 + i}-${String(m).padStart(2, '0')}`, valor: 10000 }))).flat();
}
test('projeta cada ano para 12 meses e inclui, sem somar novamente, a amostra', () => {
  const r = M.calcular(amostra(), 2021, false);
  assert.equal(r.identificado, 150000); assert.equal(r.projetado, 600000); assert.equal(r.competenciasAlvo, 60);
  assert.deepEqual(M.apresentar(r, { projetado: true }), [{ titulo: 'Estimativa projetada — 60 competências (inclui a amostra)', valor: 600000 }]);
});
test('65 competências exigem valores próprios de 13º; não usa a média da folha', () => {
  assert.equal(M.calcular(amostra(), 2021, true).projetado, null);
  const rows = amostra().concat(Array.from({ length: 5 }, (_, i) => ({ cnpj: '123', tese: 'T', regime: 'Real', competencia: `${2021 + i}-13`, valor: 2000 })));
  const r = M.calcular(rows, 2021, true);
  assert.equal(r.projetado, 610000); assert.equal(r.competenciasAlvo, 65);
});
test('bloqueia lacunas anuais, mistura de regimes, duplicidades e seleção vazia', () => {
  const rows = amostra(); rows.pop();
  assert.equal(M.calcular(rows, 2021, false).projetado, null);
  rows[0].regime = 'Presumido'; assert.equal(M.calcular(rows, 2021, false).projetado, null);
  assert.throws(() => M.calcular(amostra().concat(amostra()[0]), 2021, false), /duplicada/);
  assert.throws(() => M.apresentar(M.calcular(amostra(), 2021, false), {}), /Selecione/);
});
// Tela da suite Reversa Tax (tax/index.html na plataforma). A suite Gov nao serve essa tela — a raiz e a landing de escolha e o diagnostico e o modulo IRRF (gov.html). O teste foi herdado da plataforma e nao se aplica aqui.
test.skip('meses sem oportunidade contam na média e valor ocultado não aparece no PDF', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]).find(x => x.includes('root.GeradorMemoria ='));
  const textos = [];
  function PDF() { // stub do jsPDF: registra textos e tabelas; demais métodos são no-op
    const base = {
      internal: { pageSize: { getWidth: () => 297, getHeight: () => 210 } },
      text: x => textos.push(x), splitTextToSize: x => [x], getTextWidth: () => 10, getNumberOfPages: () => 1,
      autoTable: cfg => { textos.push(cfg.body, cfg.foot || []); base.lastAutoTable = { finalY: 80 }; },
      output: () => textos
    };
    return new Proxy(base, { get: (o, k) => (k in o ? o[k] : () => {}) });
  }
  const window = { jspdf: { jsPDF: PDF }, DiagnosticoAmostra: M, MotorCreditos: { formatarReais: x => `VALOR:${x}` } };
  vm.runInNewContext(script, { window });
  const comps = amostra().map(x => ({ ...x, nome: 'Cliente' }));
  const res = { competencias: comps, teses: [{ natureza: 'credito', aplicavel: true, curto: 'T', competencias: comps.filter(x => x.competencia.endsWith('-01')).map(x => ({ ...x, pis: 30000, cofins: 0 })) }] };
  window.GeradorMemoria.apresentar(res, 2021, { projetado: true });
  const str = JSON.stringify(textos);
  assert.ok(str.includes('VALOR:600000')); assert.ok(!str.includes('VALOR:150000'));
  textos.length = 0;
  window.GeradorMemoria.apresentar(res, 2021, { identificado: true });
  assert.ok(JSON.stringify(textos).includes('VALOR:150000')); assert.ok(!JSON.stringify(textos).includes('VALOR:600000'));
});

// Tela da suite Reversa Tax (tax/index.html na plataforma). A suite Gov nao serve essa tela — a raiz e a landing de escolha e o diagnostico e o modulo IRRF (gov.html). O teste foi herdado da plataforma e nao se aplica aqui.
test.skip('apresentação ao cliente: condicional só entra se marcada, regime sempre consta e sem código técnico', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]).find(x => x.includes('root.GeradorMemoria ='));
  const textos = [];
  function PDF() {
    const base = {
      internal: { pageSize: { getWidth: () => 297, getHeight: () => 210 } },
      text: x => textos.push(x), splitTextToSize: x => [x], getTextWidth: () => 10, getNumberOfPages: () => 1,
      autoTable: cfg => { textos.push(cfg.body, cfg.foot || []); base.lastAutoTable = { finalY: 80 }; },
      output: () => textos
    };
    return new Proxy(base, { get: (o, k) => (k in o ? o[k] : () => {}) });
  }
  const window = { jspdf: { jsPDF: PDF }, DiagnosticoAmostra: M, TesesDiagnostico: require('../teses-diagnostico'), MotorCreditos: { formatarReais: x => `VALOR:${x}` } };
  vm.runInNewContext(script, { window });
  const tese = (id, nome, valor, extra) => ({ id, nome, rubricas: [], valorNoPrazo: valor * 2, valor: valor * 2, baseNoPrazo: 0, porCompetencia: [{ competencia: '2023-03', valor }, { competencia: '2023-04', valor }], ...extra });
  const prev = {
    periodo: { inicio: '2023-03', fim: '2023-04', competencias: 2 }, empregador: { nome: 'Cliente SA', cnpjRaiz: '12345678' }, estabelecimentos: [],
    escopo: { ok: true, classTrib: '00', cprb: false, motivo: null, historico: [{ ini: '2023-03', fim: '2023-04', classTrib: '00', descricao: 'Pessoa jurídica em geral', cprb: false }] },
    teses: [tese('T066', 'Alimentação', 100), tese('T008', 'Terceiros acima de 20 salários', 777, { condicional: true, condicao: 'ação favorável' })]
  };
  const gera = inc => { textos.length = 0; window.GeradorMemoria.apresentar(null, 2021, { identificado: true }, { prev, cnpj: '12345678000190', incluirCondicionais: inc }); return JSON.stringify(textos); };
  let str = gera({});
  assert.ok(str.includes('VALOR:20000') && !str.includes('VALOR:155400') && !str.includes('Terceiros acima'));
  assert.ok(str.includes('Regime tributário ao longo do tempo') && str.includes('Pessoa jurídica em geral (Lucro Real/Presumido)'));
  assert.ok(!/classTrib|classificação tributária|T008/.test(str)); assert.ok(str.includes('pagamento das contribuições ainda não foi confirmado'));
  str = gera({ T008: true });
  assert.ok(str.includes('Terceiros acima') && str.includes('VALOR:175400')); // 20000 + 155400, igual à soma exibida
  prev.escopo = undefined; str = gera({});
  assert.ok(str.includes('Regime não identificado nos arquivos lidos'));
});

// Tela da suite Reversa Tax (tax/index.html na plataforma). A suite Gov nao serve essa tela — a raiz e a landing de escolha e o diagnostico e o modulo IRRF (gov.html). O teste foi herdado da plataforma e nao se aplica aqui.
test.skip('relatório técnico interno traz "Teses calculadas, a avaliar"; o do cliente não', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]).find(x => x.includes('root.GeradorMemoria ='));
  const textos = [];
  function PDF() {
    const base = {
      internal: { pageSize: { getWidth: () => 297, getHeight: () => 210 } },
      text: x => textos.push(x), splitTextToSize: x => [x], getTextWidth: () => 10, getNumberOfPages: () => 1,
      autoTable: cfg => { textos.push(cfg.body, cfg.foot || []); base.lastAutoTable = { finalY: 80 }; },
      output: () => textos, save: () => {}
    };
    return new Proxy(base, { get: (o, k) => (k in o ? o[k] : () => {}) });
  }
  const TD = require('../teses-diagnostico');
  const window = { jspdf: { jsPDF: PDF }, DiagnosticoAmostra: M, TesesDiagnostico: TD, MotorCreditos: { formatarReais: x => `VALOR:${x}` } };
  vm.runInNewContext(script, { window });
  const tese = (id, nome, valor) => ({ id, nome, rubricas: [], valorNoPrazo: valor, valor, baseNoPrazo: 0, porCompetencia: [{ competencia: '2023-03', valor }] });
  const prev = {
    periodo: { inicio: '2023-03', fim: '2023-03', competencias: 1 }, empregador: { nome: 'Cliente SA', cnpjRaiz: '12345678' }, estabelecimentos: [], lotacoes: [], avisos: [], premissas: { terceiros: 0.058 }, limitePrazo: '2021-10', rubricasAnalisadas: 0,
    escopo: { ok: true, classTrib: '00', cprb: false, motivo: null, historico: [] },
    teses: [tese('T066', 'Alimentação', 100), tese('T007', 'Terço de férias', 555)]
  };
  textos.length = 0;
  try { window.GeradorMemoria.gerar(null, [], { prev }); } catch (e) { /* stub parcial: o que importa são os textos registrados */ }
  let str = JSON.stringify(textos);
  assert.ok(str.includes('Teses calculadas, a avaliar'));
  assert.ok(str.includes('Tema 985 do STF é desfavorável, com modulação a partir de 15/09/2020.') && str.includes('VALOR:55500'));
  textos.length = 0;
  window.GeradorMemoria.apresentar(null, 2021, { identificado: true }, { prev, cnpj: '12345678000190', incluirCondicionais: {} });
  str = JSON.stringify(textos);
  assert.ok(!str.includes("a avaliar") && !str.includes('Terço de férias') && !str.includes('Tema 985'));
});

// Tela da suite Reversa Tax (tax/index.html na plataforma). A suite Gov nao serve essa tela — a raiz e a landing de escolha e o diagnostico e o modulo IRRF (gov.html). O teste foi herdado da plataforma e nao se aplica aqui.
test.skip('selos da tela previdenciária: tooltip da T007 e chip "Requer documento"', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.ok(/function selosTese/.test(html) && /class="pill neu tip" tabindex="0"/.test(html) && /Requer documento/.test(html));
  const TD = require('../teses-diagnostico');
  assert.equal(TD.desaconselhada('T007').motivo, 'Tema 985 do STF é desfavorável, com modulação a partir de 15/09/2020.');
  assert.ok(TD.desaconselhada('T062').motivo.includes('Tema 687') && TD.desaconselhada('T064').motivo.includes('Tema 740'));
  assert.equal(TD.desaconselhada('T067'), null);
  assert.ok(TD.requerDocumento('T077').length > 0 && TD.requerDocumento('T067') === null);
});
