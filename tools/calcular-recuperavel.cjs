// Cálculo preliminar do total recuperável — Prefeitura de Tupaciguara/MG.
//
// Regra de ouro: cada número deste arquivo nasce de uma linha da DCA (Tesouro)
// ou da folha publicada no portal do município. Nenhuma amostra, nenhum valor
// inventado. Quando a base não existe no dado público, o item é marcado como
// "a dimensionar" — com a evidência exata que falta.
//
// Fontes:
//   DCA (Siconfi, id_ente 3169604, an_exercicio 2021..2025)
//     Anexo I-C, coluna "Receitas Brutas Realizadas"  -> o que o município recebeu
//     Anexo I-D, colunas "Despesas Empenhadas | Liquidadas | Pagas" -> o que pagou
//   Portal da transparência -> folha de pagamento (competencias e verbas agregadas)
//
//   node tools/calcular-recuperavel.cjs <dca-completa.json> <folha.json> [saida.csv]
const fs = require('node:fs');

const ANOS = [2021, 2022, 2023, 2024, 2025];

// --- parametros legais (fonte primária: Planalto / RFB) -----------------------
// IRRF sobre serviços de terceiros: Lei 9.249/1995 art. 30, II, "a" (1,5%) e
// IN RFB 1.234/2012 art. 30, I (servicos em geral 1,5%; 3% transporte;
// 4,5% medicina/engenharia/advocacia; 6% consultoria/assessoria).
const ALIQUOTA_IRRF_SERVICOS = 0.015;
// CTM de Tupaciguara: base = preço do serviço (art. 77) e alíquotas na Tabela I
// (mínima 2%, máxima 5%). A base do ISSQN NÃO está na DCA — ver ressalva ISSQN.
const ALIQUOTA_ISS_MIN = 0.02;

const brl = (v) => (Number(v || 0)).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v, d = 4) => (v == null || !isFinite(v) ? '—' : (v * 100).toFixed(d).replace('.', ',') + '%');

// --- helpers sobre a DCA -----------------------------------------------------
function linhas(dca, ano, cod, coluna) {
  return dca[String(ano)].filter((i) => (!cod || i.cod_conta === cod) && (!coluna || i.coluna === coluna));
}
function valor(dca, ano, cod, coluna) {
  const l = linhas(dca, ano, cod, coluna)[0];
  return l ? Number(l.valor || 0) : null;
}
const COL_RECEITA = 'Receitas Brutas Realizadas';
// O codigo do ISSQN mudou no Tesouro em 2021 (RO1.1.1.4.51.1.0 a partir de
// 2022; RO1.1.1.8.02.3.0 em 2021). Buscar so pelo codigo novo zera R$ 3,3
// milhoes de imposto declarado: o fallback casa pelo ROTULO da conta.
function valorIssqn(dca, ano) {
  const direto = valor(dca, ano, 'RO1.1.1.4.51.1.0', COL_RECEITA);
  if (direto) return direto;
  const achado = linhas(dca, ano, null, COL_RECEITA).find((i) => /issqn|imposto sobre servi/i.test(i.conta || ''));
  return achado ? Number(achado.valor || 0) : 0;
}
const COL_PAGAS = 'Despesas Pagas';
const COL_LIQ = 'Despesas Liquidadas';
const COL_EMP = 'Despesas Empenhadas';

// --- cálculo ----------------------------------------------------------------
function calcular(dca, folha) {
  const linhasMemoria = [];
  const add = (item, ano, base, fator, obs, valorCalculado, baseLegal, fonte, grau) =>
    linhasMemoria.push({ item, ano, base: num(base), fator, observado: num(obs), valor: num(valorCalculado || 0), baseLegal, fonte, grau });

  const serie = ANOS.map((ano) => {
    // --- IRRF sobre servicos de terceiros (municipio como tomador) ---
    const servPJ = valor(dca, ano, 'DO3.3.90.39.00.00', COL_PAGAS) || 0;      // outros servicos PJ
    const consultoria = valor(dca, ano, 'DO3.3.90.35.00.00', COL_PAGAS) || 0; // servicos de consultoria
    const ti = valor(dca, ano, 'DO3.3.90.40.00.00', COL_PAGAS) || 0;          // servicos de TI/comunicacao
    const baseServicos = servPJ + consultoria + ti;
    const irrfServicos = valor(dca, ano, 'RO1.1.1.3.03.4.0', COL_RECEITA) || 0; // IRRF retido - outros rendimentos
    const irrfTotal = valor(dca, ano, 'RO1.1.1.3.03.0.0', COL_RECEITA) || 0;
    const irrfFolha = valor(dca, ano, 'RO1.1.1.3.03.1.0', COL_RECEITA) || 0;
    const taxaObs = baseServicos ? irrfServicos / baseServicos : null;
    const esperado15 = baseServicos * ALIQUOTA_IRRF_SERVICOS;
    const deficit15 = esperado15 - irrfServicos;

    // --- ISSQN (arrecadado; base fora do dado publico) ---
    const issqn = valorIssqn(dca, ano);
    const receitaServicos = valor(dca, ano, 'RO1.6.0.0.00.0.0', COL_RECEITA) || 0;

    // --- folha (portal) ---
    const fAno = folha.filter((r) => String(r.mesReferencia).slice(0, 4) === String(ano));
    const bruto = fAno.reduce((s, r) => s + (Number(r.vlrSalarioBruto) || 0), 0);
    const baseSal = fAno.reduce((s, r) => s + (Number(r.vlrSalarioBase) || 0), 0);
    const desc = fAno.reduce((s, r) => s + (Number(r.vlrDesconto) || 0), 0);
    const comps = new Set(fAno.map((r) => r.mesReferencia));
    const n13 = fAno.filter((r) => ['P13', 'A13'].includes(String(r.indRotina))).length;

    add('IRRF s/ serviços de terceiros — teto da defasagem (1,5%)', ano, baseServicos, '1,5% (IN RFB 1.234/2012 art. 30, I)', irrfServicos, deficit15,
      'Lei 9.249/1995 art. 30, II, "a"; IN RFB 1.234/2012 art. 30', 'DCA: DO3.3.90.39/35/40 (Despesas Pagas) x RO1.1.1.3.03.4.0 (Receitas Brutas Realizadas)', 'teto');
    add('ISSQN — base de calculo', ano, '—', '2% a 5% (CTM, Tabela I)', issqn, null,
      'CTM Tupaciguara art. 77 (base = preço do serviço) e art. 266 (alíquota 2%-5%)', 'DCA: RO1.1.1.4.51.1.0 (arrecadado). BASE AUSENTE NO DADO PUBLICO', 'a dimensionar');
    add('IRRF sobre a folha do município (custo, nao recuperacao)', ano, bruto, 'tabela progressiva mensal', irrfFolha, null,
      'Lei 9.250/1995 art. 1º; Lei 11.482/2007 (tabelas); Lei 15.191/2025', 'DCA: RO1.1.1.3.03.1.0 x folha publica', 'a dimensionar');
    add('INSS/RPPS sobre a folha (custo, nao recuperacao)', ano, baseSal, '20% ate o teto (RPPS)', desc, null,
      'Lei 8.212/1991 art. 28; 13º integra o salario de contribuicoes (art. 28, §5º)', 'folha publica: vlrSalarioBase x vlrDesconto', 'a dimensionar');

    return { ano, servPJ, consultoria, ti, baseServicos, irrfServicos, irrfTotal, irrfFolha, taxaObs, esperado15, deficit15, issqn, receitaServicos, bruto, baseSal, desc, comps: comps.size, n13,
      servPagasEmpenhadas: valor(dca, ano, 'DO3.3.90.39.00.00', COL_EMP), servPagasLiquidadas: valor(dca, ano, 'DO3.3.90.39.00.00', COL_LIQ) };
  });

  const soma = (f) => serie.reduce((s, l) => s + (f(l) || 0), 0);
  const totais = {
    baseServicos: soma((l) => l.baseServicos),
    irrfServicos: soma((l) => l.irrfServicos),
    irrfTotal: soma((l) => l.irrfTotal),
    irrfFolha: soma((l) => l.irrfFolha),
    issqn: soma((l) => l.issqn),
    bruto: soma((l) => l.bruto),
    desc: soma((l) => l.desc),
    esperado15: soma((l) => l.esperado15),
    deficit15: soma((l) => l.deficit15)
  };
  return { serie, totais, linhasMemoria };
}

// --- execucao ----------------------------------------------------------------
const [arqDca, arqFolha, arqCsv] = process.argv.slice(2);
if (!arqDca) { console.error('uso: node tools/calcular-recuperavel.cjs <dca.json> <folha.json> [saida.csv]'); process.exit(1); }
const dca = JSON.parse(fs.readFileSync(arqDca, 'utf8'));
const folha = arqFolha && fs.existsSync(arqFolha) ? JSON.parse(fs.readFileSync(arqFolha, 'utf8')) : [];
const r = calcular(dca, folha);

console.log('\n  === CALCULO PRELIMINAR DO TOTAL RECUPERAVEL — Tupaciguara/MG ===\n');
console.log('  A) IRRF SOBRE SERVICOS DE TERCEIROS (municipio como tomador)');
console.log('     base = DCA I-D, Despesas PAGAS | observado = DCA I-C, Receitas Brutas Realizadas');
console.log('     fator = 1,5% (Lei 9.249/95 art. 30, II, "a"; IN RFB 1.234/2012 art. 30, I)\n');
console.log('     ano | base servicos PJ | IRRF retido | taxa observada | esperado 1,5% | defasagem (teto)');
for (const l of r.serie) {
  console.log(`     ${l.ano} | ${num(l.baseServicos).padStart(16)} | ${num(l.irrfServicos).padStart(12)} | ${pct(l.taxaObs).padStart(11)} | ${num(l.esperado15).padStart(13)} | ${num(l.deficit15).padStart(16)}`);
}
const T = r.totais;
console.log(`     TOTAL | ${num(T.baseServicos).padStart(15)} | ${num(T.irrfServicos).padStart(12)} | ${pct(T.irrfServicos / T.baseServicos).padStart(11)} | ${num(T.esperado15).padStart(13)} | ${num(T.deficit15).padStart(16)}`);

console.log('\n     [a] base por conta (Despesas Pagas):');
for (const l of r.serie) console.log(`         ${l.ano}: 3.3.90.39 ${num(l.servPJ).padStart(14)} | 3.3.90.35 consultoria ${num(l.consultoria).padStart(11)} | 3.3.90.40 TI ${num(l.ti).padStart(12)}`);
console.log('\n     [b] o mesmo item na coluna Empenhadas (a base que NAO deve ser usada com a retencao):');
for (const l of r.serie) console.log(`         ${l.ano}: empenhadas ${num(l.servPagasEmpenhadas).padStart(14)} | liquidadas ${num(l.servPagasLiquidadas).padStart(14)} | pagas ${num(l.servPJ).padStart(14)}`);

console.log('\n  B) ISSQN — o que o dado publico sustenta e o que nao sustenta');
for (const l of r.serie) {
  console.log(`     ${l.ano}: arrecadado ${num(l.issqn).padStart(13)} | receita de servicos (DCA 1.6) ${num(l.receitaServicos).padStart(14)} | razao ${pct(l.issqn / l.receitaServicos, 1).padStart(8)}`);
}
console.log('     → a razao acima de 100% prova que a base do ISSQN NAO e a linha 1.6 da DCA:');
console.log('       o ISSQN incide sobre receita de servicos que nao aparece nessa linha. Sem a base,');
console.log('       nao ha como calcular a defasagem — e o dado publico nao a traz.');

console.log('\n  C) FOLHA (portal do municipio) — sinais, nao valores');
for (const l of r.serie) console.log(`     ${l.ano}: bruto ${num(l.bruto).padStart(14)} | base ${num(l.baseSal).padStart(14)} | descontos ${num(l.desc).padStart(13)} (${pct(l.desc / l.bruto, 2).padStart(7)}) | lancamentos 13o ${String(l.n13).padStart(5)} | competencias ${l.comps}`);
console.log(`     TOTAL: bruto ${num(T.bruto)} | descontos ${num(T.desc)} (${pct(T.desc / T.bruto, 2)})`);

console.log('\n  D) TOTAL RECUPERAVEL PRELIMINAR (unico bloco calculavel com dado publico)');
console.log(`     IRRF sobre servicos: ${brl(Math.max(0, T.deficit15))}  (teto, 5 anos, 1,5% de referencia)`);
console.log(`     IRRF sobre servicos - observado: ${brl(T.irrfServicos)} | base: ${brl(T.baseServicos)}`);
console.log(`     ISSQN: a dimensionar (falta a base) | IRRF/INSS da folha: custo, nao recuperavel`);

if (arqCsv) {
  const cab = ['item', 'ano', 'base', 'fator', 'observado', 'valor', 'base_legal', 'fonte', 'grau'];
  const csv = [cab.join(';')].concat(r.linhasMemoria.map((l) => [l.item, l.ano, l.base, l.fator, l.observado, l.valor, l.baseLegal, l.fonte, l.grau].map((x) => `"${String(x).replace(/"/g, "'")}"`).join(';'))).join('\n');
  fs.writeFileSync(arqCsv, csv);
  console.log(`\n  memoria de calculo gravada: ${arqCsv} (${r.linhasMemoria.length} linhas)`);
}
fs.writeFileSync('/workspace/calculo-recuperavel.json', JSON.stringify(r, null, 1));
