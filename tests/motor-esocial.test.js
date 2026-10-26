// Motor previdenciário: leitura dos XML do eSocial (S-1005, S-1010, S-1020, S-1200) e estimativa por tese.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../motor-esocial.js');

const NS = 'http://www.esocial.gov.br/schema/evt';
const emp = '<ideEmpregador><tpInsc>1</tpInsc><nrInsc>12345678</nrInsc></ideEmpregador>';
const xml = (evt, corpo, id) => `<?xml version="1.0" encoding="UTF-8"?><eSocial xmlns="${NS}/${evt}/v_S_01_02_00"><${evt} Id="${id || 'ID1'}">${emp}${corpo}</${evt}></eSocial>`;

const S1005 = xml('evtTabEstab', `<infoEstab><inclusao><ideEstab><tpInsc>1</tpInsc><nrInsc>12345678000190</nrInsc><iniValid>2021-01</iniValid></ideEstab>
  <dadosEstab><cnaePrep>2511000</cnaePrep><aliqGilrat><aliqRat>3</aliqRat><fap>1.5000</fap></aliqGilrat></dadosEstab></inclusao></infoEstab>`);
function rub(cod, dsc, natRubr, tpRubr, codIncCP) {
  return `<inclusao><ideRubrica><codRubr>${cod}</codRubr><ideTabRubr>T1</ideTabRubr><iniValid>2021-01</iniValid></ideRubrica>
    <dadosRubrica><dscRubr>${dsc}</dscRubr><natRubr>${natRubr}</natRubr><tpRubr>${tpRubr}</tpRubr><codIncCP>${codIncCP}</codIncCP><codIncIRRF>11</codIncIRRF><codIncFGTS>11</codIncFGTS></dadosRubrica></inclusao>`;
}
// lote com várias rubricas, como os arquivos baixados do eSocial
const S1010 = `<eSocial xmlns="http://www.esocial.gov.br/schema/lote/eventos/envio/v1_1_1"><envioLoteEventos><eventos>
  <evento Id="A">${xml('evtTabRubrica', '<infoRubrica>' + rub('001', 'Salário Base', '1000', '1', '11') + '</infoRubrica>').replace(/<\?xml[^>]*\?>/, '')}</evento>
  <evento Id="B">${xml('evtTabRubrica', '<infoRubrica>' + rub('010', 'Terço Constitucional de Férias', '1020', '1', '11') + '</infoRubrica>').replace(/<\?xml[^>]*\?>/, '')}</evento>
  <evento Id="C">${xml('evtTabRubrica', '<infoRubrica>' + rub('020', 'Aviso Prévio Indenizado', '6001', '1', '11') + '</infoRubrica>').replace(/<\?xml[^>]*\?>/, '')}</evento>
  <evento Id="D">${xml('evtTabRubrica', '<infoRubrica>' + rub('030', 'Auxílio Doença 15 dias', '1010', '1', '11') + '</infoRubrica>').replace(/<\?xml[^>]*\?>/, '')}</evento>
  <evento Id="E">${xml('evtTabRubrica', '<infoRubrica>' + rub('040', 'Vale Transporte em dinheiro', '1810', '1', '00') + '</infoRubrica>').replace(/<\?xml[^>]*\?>/, '')}</evento>
  <evento Id="F">${xml('evtTabRubrica', '<infoRubrica>' + rub('050', 'DSR s/ horas extras', '1050', '1', '11') + '</infoRubrica>').replace(/<\?xml[^>]*\?>/, '')}</evento>
  <evento Id="G">${xml('evtTabRubrica', '<infoRubrica>' + rub('900', 'INSS segurado', '9201', '2', '31') + '</infoRubrica>').replace(/<\?xml[^>]*\?>/, '')}</evento>
</eventos></envioLoteEventos></eSocial>`;
const S1020 = xml('evtTabLotacao', `<infoLotacao><inclusao><ideLotacao><codLotacao>L1</codLotacao><iniValid>2021-01</iniValid></ideLotacao>
  <dadosLotacao><tpLotacao>01</tpLotacao><fpasLotacao><fpas>507</fpas><codTercs>0079</codTercs></fpasLotacao></dadosLotacao></inclusao></infoLotacao>`);
function s1200(cpf, per, itens, retif) {
  return xml('evtRemun', `<ideEvento><indRetif>${retif ? 2 : 1}</indRetif>${retif ? '<nrRecibo>1.1.1</nrRecibo>' : ''}<indApuracao>1</indApuracao><perApur>${per}</perApur><tpAmb>1</tpAmb><procEmi>1</procEmi><verProc>1</verProc></ideEvento>
    <ideTrabalhador><cpfTrab>${cpf}</cpfTrab></ideTrabalhador><dmDev><ideDmDev>1</ideDmDev><codCateg>101</codCateg><infoPerApur><ideEstabLot><tpInsc>1</tpInsc><nrInsc>12345678000190</nrInsc><codLotacao>L1</codLotacao>
    <remunPerApur>${itens.map(([c, v]) => `<itensRemun><codRubr>${c}</codRubr><ideTabRubr>T1</ideTabRubr><vrRubr>${v}</vrRubr></itensRemun>`).join('')}</remunPerApur></ideEstabLot></infoPerApur></dmDev>`, 'R' + cpf + per);
}

test('ESOCIAL-001: reconhece eventos, inclusive em lote; recusa arquivo que não é eSocial', () => {
  const l = M.lerXml(S1010, 'lote.xml');
  assert.equal(l.erros.length, 0);
  assert.equal(l.eventos.filter((e) => e.tipo === 'S-1010').length, 7);
  assert.match(M.lerXml('<nfeProc/>', 'nota.xml').erros[0], /Não é um XML do eSocial/);
});

test('ESOCIAL-002: apura por tese só rubricas de vencimento com incidência patronal; retificadora substitui', () => {
  const lidos = [
    M.lerXml(S1005, 's1005.xml'), M.lerXml(S1010, 's1010.xml'), M.lerXml(S1020, 's1020.xml'),
    M.lerXml(s1200('11111111111', '2025-03', [['001', '5000.00'], ['010', '1000.00'], ['020', '2000.00'], ['040', '300'], ['050', '400'], ['900', '550']]), 'a.xml'),
    // original e retificadora da mesma competência: vale a retificadora (aviso 3000 em vez de 2000)
    M.lerXml(s1200('22222222222', '2025-04', [['001', '4000'], ['020', '2000']]), 'b.xml'),
    M.lerXml(s1200('22222222222', '2025-04', [['001', '4000'], ['020', '3000'], ['030', '800']], true), 'b-retif.xml'),
    // competência fora dos 5 anos
    M.lerXml(s1200('11111111111', '2020-01', [['010', '1000']]), 'antigo.xml')
  ];
  const r = M.apurar(lidos, { hoje: new Date('2026-10-14') });
  const t = Object.fromEntries(r.teses.map((x) => [x.id, x]));
  const aliq = 0.20 + 0.03 * 1.5 + 0.058; // CPP + RAT×FAP + terceiros
  assert.equal(t.T007.base, 2000);
  assert.equal(t.T007.baseNoPrazo, 1000);
  assert.equal(t.T007.valorNoPrazo, Math.round(1000 * aliq * 100) / 100);
  assert.equal(t.T005.base, 5000, 'retificadora substitui a original');
  assert.equal(t.T006.base, 800);
  assert.equal(t.T067, undefined, 'vale-transporte sem incidência (codIncCP 00) não entra');
  assert.equal(t.T069.base, 400, 'DSR entra como reflexo do RAT');
  assert.equal(t.T069.valor, Math.round(400 * 0.045 * 100) / 100);
  assert.ok(!r.teses.some((x) => x.rubricas.some((ru) => ru.cod === '001' || ru.cod === '900')), 'salário base e desconto do segurado não entram');
  assert.equal(r.eventos['S-1200'], 4);
  assert.equal(r.estabelecimentos[0].rat, 3);
  assert.equal(r.lotacoes[0].fpas, '507');
  assert.equal(t.T005.rubricas[0].motivo, 'aviso-prévio indenizado');
});

test('ESOCIAL-003: sem S-1010 avisa que falta a tabela de rubricas', () => {
  const r = M.apurar([M.lerXml(s1200('1', '2025-03', [['001', '10']]), 'x.xml')], { hoje: new Date('2026-10-14') });
  assert.match(r.avisos.join(' '), /S-1010/);
  assert.equal(r.teses.length, 0);
});

test('ESOCIAL-004: classificação das rubricas pela descrição', () => {
  const c = (d) => (M.classificar(d) || {}).id;
  assert.equal(c('SALARIO MATERNIDADE'), 'T004');
  assert.equal(c('Licença Paternidade'), 'T064');
  assert.equal(c('Aviso Prévio Indenizado'), 'T005');
  assert.equal(c('1/3 Férias'), 'T007');
  // mudou por design (v0.2.0): férias indenizadas e 1/3 agora têm tese própria (T073), antes caíam em T028
  assert.equal(c('1/3 Férias Indenizadas'), 'T073');
  assert.equal(c('Multa Art. 477 CLT'), 'T071');
  assert.equal(c('Indenização Art. 479 CLT'), 'T072');
  assert.equal(c('Indenização por dano'), 'T028');
  assert.equal(c('PLR'), 'T063');
  assert.equal(c('Domingos e feriados trabalhados'), 'T062');
  assert.equal(c('Gratificação por desempenho'), 'T065');
  assert.equal(c('Auxílio Alimentação'), 'T066');
  assert.equal(c('Plano de Saúde'), 'T068');
  assert.equal(c('Salário Base'), undefined);
});

test('ESOCIAL-005: valor por competência (base da Selic) fecha com o total da tese e marca o prazo', () => {
  const lidos = [
    M.lerXml(S1005, 's1005.xml'), M.lerXml(S1010, 's1010.xml'), M.lerXml(S1020, 's1020.xml'),
    M.lerXml(s1200('11111111111', '2025-03', [['010', '1000.00'], ['050', '400']]), 'a.xml'),
    M.lerXml(s1200('11111111111', '2025-04', [['010', '500.00']]), 'b.xml'),
    M.lerXml(s1200('11111111111', '2020-01', [['010', '1000']]), 'antigo.xml')
  ];
  const r = M.apurar(lidos, { hoje: new Date('2026-10-14') });
  r.teses.forEach((t) => {
    const soma = Math.round(t.porCompetencia.reduce((s, c) => s + c.valor, 0) * 100) / 100;
    assert.ok(Math.abs(soma - t.valor) < 0.02, t.id + ': soma por competência = valor');
    const np = Math.round(t.porCompetencia.filter((c) => c.noPrazo).reduce((s, c) => s + c.valor, 0) * 100) / 100;
    assert.ok(Math.abs(np - t.valorNoPrazo) < 0.02, t.id + ': soma no prazo = valorNoPrazo');
  });
  const t007 = r.teses.find((x) => x.id === 'T007');
  assert.deepEqual(t007.porCompetencia.map((c) => [c.competencia, c.noPrazo]), [['2020-01', false], ['2025-03', true], ['2025-04', true]]);
  assert.ok(r.teses.find((x) => x.id === 'T069').porCompetencia.length === 1, 'reflexo (DSR) também traz a competência');
});

// 13o: apuracao anual (indApuracao=2) com perApur = ano. E competencia propria.
function s1200_13(cpf, ano, itens) {
  return xml('evtRemun', `<ideEvento><indRetif>1</indRetif><indApuracao>2</indApuracao><perApur>${ano}</perApur><tpAmb>1</tpAmb><procEmi>1</procEmi><verProc>1</verProc></ideEvento>
    <ideTrabalhador><cpfTrab>${cpf}</cpfTrab></ideTrabalhador><dmDev><ideDmDev>1</ideDmDev><codCateg>101</codCateg><infoPerApur><ideEstabLot><tpInsc>1</tpInsc><nrInsc>12345678000190</nrInsc><codLotacao>L1</codLotacao>
    <remunPerApur>${itens.map(([c, v]) => `<itensRemun><codRubr>${c}</codRubr><ideTabRubr>T1</ideTabRubr><vrRubr>${v}</vrRubr></itensRemun>`).join('')}</remunPerApur></ideEstabLot></infoPerApur></dmDev>`, 'R' + cpf + '13' + ano);
}

test('ESOCIAL-09X: folha de 5 anos tem 65 competencias (60 nominais + 5 de 13o); o 13o e competencia propria', () => {
  // 60 competencias nominais (2021-01 a 2025-12) + 5 de 13o (2021 a 2025)
  const lidos = [M.lerXml(S1005, 's1005.xml'), M.lerXml(S1010, 's1010.xml'), M.lerXml(S1020, 's1020.xml')];
  for (let ano = 2021; ano <= 2025; ano++) {
    for (let mes = 1; mes <= 12; mes++) {
      const per = `${ano}-${String(mes).padStart(2, '0')}`;
      lidos.push(M.lerXml(s1200('11111111111', per, [['010', '100']]), `${per}.xml`));
    }
    lidos.push(M.lerXml(s1200_13('11111111111', String(ano), [['010', '700']]), `13-${ano}.xml`));
  }
  const r = M.apurar(lidos, { hoje: new Date('2026-10-14') });
  const t = Object.fromEntries(r.teses.map((x) => [x.id, x]));

  assert.equal(r.periodo.competencias, 65, '60 meses + 5 decimos terceiros');
  assert.equal(r.periodo.competenciasNominais, 60);
  assert.equal(r.periodo.competenciasDecimoTerceiro, 5);

  // o 13o nao e fundido em dezembro: competencia propria, com a propria base
  assert.equal(t.T007.competencias, 65);
  assert.equal(t.T007.base, 60 * 100 + 5 * 700, 'base do 13o somada a parte, nao substituindo dezembro');
  const pc = Object.fromEntries(t.T007.porCompetencia.map((x) => [x.competencia, x]));
  const aliq = 0.20 + 0.03 * 1.5 + 0.058;
  assert.equal(pc['2021-12'].valor, Math.round(100 * aliq * 100) / 100, 'dezembro nominal');
  assert.equal(pc['2021-12/13'].valor, Math.round(700 * aliq * 100) / 100, '13o de dezembro: competencia a parte');
  assert.equal(pc['2021-12/13'].noPrazo, true, '13o dentro da janela de 5 anos');

  // o 13o nao cria vinculo/cabeca nova (T061): 1 trabalhador x 60 meses
  assert.equal(r.ratPreponderante.empregadosCompetencias, 60, 'o 13o nao vira cabeca extra');
});
