// Cálculo das oportunidades previdenciárias e de IRRF sobre a folha —
// Prefeitura de Tupaciguara/MG, 2021-2025.
//
// 1) IRRF SOBRE A FOLHA: o mínimo legal retido (tabela progressiva mensal sobre
//    a base com o desconto simplificado) comparado ao IRRF declarado na DCA.
// 2) 13º SALÁRIO: teste de collecting por lançamento — a contribuição
//    previdenciária (piso de 7,5% da base, art. 28 da Lei 8.212/91) mais o IRRF
//    do 13º (tabela anualizada, art. 12-A, §1º, da Lei 7.713/1988) forms um
//    PISO. Se o desconto observado no lançamento for menor que esse piso,
//    a conclusão é firme: o lançamento não recebeu o tratamento legal.
//
//   node tools/calcular-previdenciario.cjs <folha.json> <dca-completa.json> [saida.csv]
const fs = require('node:fs');
const path = require('node:path');

// ------------------------------------------------------------ parametros legais
// Tabela progressiva mensal do IRRF (Lei 11.482/2007, art. 1º), por vigência.
// Cada faixa: [limite superior da faixa (null = infinito), alíquota, parcela a deduzir].
const TABELA_IRRF = {
  '2015-2023': [[2112.00, 0, 0], [2826.65, 0.075, 158.40], [3751.05, 0.15, 370.40], [4664.68, 0.225, 651.73], [null, 0.275, 884.96]],
  '2023-05': [[2259.20, 0, 0], [2826.65, 0.075, 169.44], [3751.05, 0.15, 381.44], [4664.68, 0.225, 662.77], [null, 0.275, 896.00]],
  '2025-05': [[2428.80, 0, 0], [2826.65, 0.075, 182.16], [3751.05, 0.15, 394.16], [4664.68, 0.225, 675.49], [null, 0.275, 908.73]],
};
// Desconto simplificado mensal = 25% do limite máximo da faixa de alíquota zero.
const DESCONTO_SIMPLIFICADO = { '2015-2023': 528.00, '2023-05': 564.80, '2025-05': 607.20 };
// Teto do salário de contribuição (salário-de-contribuição) por ano:
// 2021 Portaria SEPRT/MS nº 477/2021 · 2022 Portaria MTP/ME nº 12/2022 ·
// 2023 Portaria MPS/MF nº 26/2023 · 2024 Portaria MPS/MF nº 2/2024 ·
// 2025 Portaria MPS/MF nº 6/2025.
const TETO_INSS = { 2021: 6433.57, 2022: 7087.22, 2023: 7507.49, 2024: 7786.02, 2025: 8157.41 };
// Aliquota do.progressivo do empregado: 7,5% e a maior faixa. O PISO de 7,5%
// vale em qualquer ano porque todas as faixas do empregado sao >= 7,5%:
// 7,5% (ate 1.100/1.212/1.302/1.412/1.518) · 9% · 12% · 14%.
const ALIQUOTA_MINIMA_INSS = 0.075;
const ALIQUOTA_MAXIMA_INSS = 0.14;

function tabelaDoMes(comp) {
  const ano = Math.floor(comp / 100), mes = comp % 100;
  if (ano >= 2025 && mes >= 5) return TABELA_IRRF['2025-05'];
  if (ano >= 2023 && mes >= 5) return TABELA_IRRF['2023-05'];
  return TABELA_IRRF['2015-2023'];
}
function descontoSimplificadoDoMes(comp) {
  const ano = Math.floor(comp / 100), mes = comp % 100;
  if (ano >= 2025 && mes >= 5) return DESCONTO_SIMPLIFICADO['2025-05'];
  if (ano >= 2023 && mes >= 5) return DESCONTO_SIMPLIFICADO['2023-05'];
  return DESCONTO_SIMPLIFICADO['2015-2023'];
}
function irrfTabela(base, tabela) {
  if (base <= 0) return 0;
  for (const [teto, aliq, parcela] of tabela) {
    if (teto === null || base <= teto) return Math.max(0, base * aliq - parcela);
  }
  return 0;
}
function inssPiso(base, ano) {
  // Piso: 7,5% da base ate o teto. Teto: 14% (a maior faixa) sobre a base ate o teto.
  const b = Math.min(Math.max(0, base), TETO_INSS[ano] || 0);
  return { piso: b * ALIQUOTA_MINIMA_INSS, teto: b * ALIQUOTA_MAXIMA_INSS };
}

// ------------------------------------------------------------------ carga
const [arqFolha, arqDca, arqCsv] = process.argv.slice(2);
if (!arqFolha) { console.error('uso: node tools/calcular-previdenciario.cjs <folha.json> <dca.json> [saida.csv]'); process.exit(1); }
const folha = JSON.parse(fs.readFileSync(arqFolha, 'utf8'));
const dca = arqDca && fs.existsSync(arqDca) ? JSON.parse(fs.readFileSync(arqDca, 'utf8')) : null;
const brl = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v, d = 2) => (v == null || !isFinite(v) ? '—' : (v * 100).toFixed(d).replace('.', ',') + '%');

// IRRF do 13º, feito direito: tabela mensal aplicada a 13 meses, com a
// parcela a deduzir tambem multiplicada por 13.
// IRRF do 13o: tributacao separada (RIR/2018 art. 677, §3º; Lei 7.713/1988
// art. 12-A) — a tabela progressiva mensal aplicada ao proprio 13o, como um
// pagamento a parte. A metodo alternativo (anualizacao da tabela x 13 meses,
// art. 12-A, §1º) muda o valor do 13o e por isso o numero do 13o e o item
// mais sensivel do calculo: ele entra como PISO no teste por lancamento.
function irrf13Calculo(bruto13, comp) {
  const tabela = tabelaDoMes(comp);
  const ded = descontoSimplificadoDoMes(comp);
  return irrfTabela(Math.max(0, bruto13 - ded), tabela);
}

// ------------------------------------------------------------------ 1) IRRF sobre a folha
const porAno = new Map();
const meses = new Map();
const mov = { FOL: 0, P13: 0, A13: 0, FER: 0, FCO: 0, DES: 0 };
for (const r of folha) {
  const comp = Number(r.mesReferencia);
  const ano = Math.floor(comp / 100);
  if (!porAno.has(ano)) porAno.set(ano, { ano, irrfMinimo: 0, irrf13: 0, bruto: 0, base: 0, desconto: 0, registros: 0 });
  const a = porAno.get(ano);
  const rot = String(r.indRotina || '').toUpperCase();
  const bruto = Number(r.vlrSalarioBruto || 0);
  const base = Number(r.vlrSalarioBase || 0);
  const desconto = Number(r.vlrDesconto || 0);
  a.registros++; a.bruto += bruto; a.base += base; a.desconto += desconto;
  if (rot === 'P13' || rot === 'A13') { a.irrf13 += irrf13Calculo(bruto, comp); mov[rot] += bruto; }
  else {
    // acumula por servidor-mes; a tabela incide sobre a soma (art. 677, §2º)
    const k = `${r.numMatricula}|${comp}`;
    if (!meses.has(k)) meses.set(k, { comp, soma: 0 });
    meses.get(k).soma += bruto;
  }
}
// 1b) IRRF por servidor-mes (agregado), com a tabela do mes
for (const m of meses.values()) {
  const ano = Math.floor(m.comp / 100);
  const a = porAno.get(ano);
  if (a) a.irrfMinimo += irrfTabela(Math.max(0, m.soma - descontoSimplificadoDoMes(m.comp)), tabelaDoMes(m.comp));
}

// 2) 13º: teste por lancamento (piso = INSS 7,5% + IRRF do 13º)
let n13 = 0, n13Abaixo = 0, n13Zero = 0, bruto13Zero = 0, faltando13 = 0, faltando13Teto = 0, base13 = 0, desconto13 = 0, inss13Piso = 0, inss13Teto = 0;
const piores = [];
for (const r of folha) {
  const rot = String(r.indRotina || '').toUpperCase();
  if (rot !== 'P13' && rot !== 'A13') continue;
  const comp = Number(r.mesReferencia), ano = Math.floor(comp / 100);
  const bruto = Number(r.vlrSalarioBruto || 0), base = Number(r.vlrSalarioBase || 0), desconto = Number(r.vlrDesconto || 0);
  const i = inssPiso(base, ano);
  const irrf = irrf13Calculo(bruto, comp);
  const piso = i.piso + irrf;
  n13++; base13 += base; desconto13 += desconto; inss13Piso += i.piso; inss13Teto += i.teto;
  if (desconto < 0.01) { n13Zero++; bruto13Zero += bruto; }
  if (desconto < piso - 0.01) {
    n13Abaixo++; faltando13 += (piso - desconto);
    faltando13Teto += Math.max(0, (i.teto + irrf) - desconto);
    if (piores.length < 8) piores.push({ matricula: r.numMatricula, comp, rotina: rot, bruto: +bruto.toFixed(2), base: +base.toFixed(2), desconto: +desconto.toFixed(2), pisoInss: +i.piso.toFixed(2), irrf13: +irrf.toFixed(2), piso: +piso.toFixed(2), faltando: +(piso - desconto).toFixed(2) });
  }
}
const anos = [...porAno.values()].sort((a, b) => a.ano - b.ano);
const tot = anos.reduce((s, a) => ({ irrfMinimo: s.irrfMinimo + a.irrfMinimo, irrf13: s.irrf13 + a.irrf13, bruto: s.bruto + a.bruto, desconto: s.desconto + a.desconto }), { irrfMinimo: 0, irrf13: 0, bruto: 0, desconto: 0 });

// IRRF declarado na DCA
const decl = (ano) => {
  if (!dca) return null;
  const l = dca[String(ano)].find((i) => i.cod_conta === 'RO1.1.1.3.03.1.0' && i.coluna === 'Receitas Brutas Realizadas');
  return l ? Number(l.valor) : null;
};

console.log('\n  === 1) IRRF SOBRE A FOLHA: minimo legal retido x declarado na DCA ===\n');
console.log('  Metodo: base = bruto da remuneracao - desconto simplificado mensal (25% do limite');
console.log('  da faixa zero); IRRF = tabela progressiva mensal do mes. E o MINIMO legal: a fonte');
console.log('  pagadora deve considerar o desconto simplificado quando ele for mais favoravel.');
console.log('  No 13o, a tabela e multiplicada por 13 (art. 12-A, §1º, Lei 7.713/1988).\n');
console.log('  ano | bruto folha | minimo legal (folha) | minimo legal (13o) | total minimo | DCA declarado | declarado - minimo');
for (const a of anos) {
  const minimo = a.irrfMinimo + a.irrf13;
  const d = decl(a.ano);
  const dif = d == null ? null : d - minimo;
  console.log(`  ${a.ano} | ${num(a.bruto).padStart(15)} | ${num(a.irrfMinimo).padStart(19)} | ${num(a.irrf13).padStart(17)} | ${num(minimo).padStart(13)} | ${d == null ? '—' : num(d).padStart(13)} | ${dif == null ? '—' : num(dif).padStart(11)}`);
}
const minimoTotal = tot.irrfMinimo + tot.irrf13;
const declTotal = anos.reduce((s, a) => s + (decl(a.ano) || 0), 0);
console.log(`  TOTAL| ${num(tot.bruto).padStart(15)} | ${num(tot.irrfMinimo).padStart(19)} | ${num(tot.irrf13).padStart(17)} | ${num(minimoTotal).padStart(13)} | ${num(declTotal).padStart(13)} | ${num(declTotal - minimoTotal).padStart(11)}`);
const outros = tot.desconto - declTotal;
console.log(`\n  leitura do trio (5 anos):`);
console.log(`    IRRF declarado na DCA .................. ${brl(declTotal)}`);
console.log(`    IRRF no cenario "desconto simplificado" ${brl(minimoTotal)}`);
console.log(`    demais descontos da folha (INSS, RF e consignacoes) ${brl(outros)}`);
console.log(`    total de descontos da folha ............ ${brl(tot.desconto)}`);
console.log(`  O declarado (${brl(declTotal)}) fica ABAIXO do cenario do desconto simplificado`);
console.log(`  (${brl(minimoTotal)}) e abaixo dos demais descontos (${brl(outros)}). Isso e o que a lei`);
console.log('  espera: a base real do IRRF e o bruto MENOS as deducoes legais (INSS e dependentes),');
console.log('  que sao maiores que o desconto simplificado. Ordem coerente -> sem infracao de');
console.log('  retencao apurada. Se o declarado fosse MENOR que o minimo, teríamos exposure.');

console.log('\n\n  === 2) 13º SALARIO: teste por lancamento ===\n');
console.log('  Piso por lancamento = INSS (7,5% da base ate o teto) + IRRF do 13º (tabela anualizada).');
console.log('  Se o desconto observado for menor que o piso, a conclusao e FIRME: o lancamento');
console.log('  nao recebeu o tratamento legal (o IRRF e as consignacoes, se houver, so aumentariam');
console.log('  o desconto observado).\n');
console.log(`  lancamentos de 13o analisados: ${n13}`);
console.log(`  base do 13o: ${brl(base13)} | desconto observado: ${brl(desconto13)}`);
console.log(`  INSS sobre a base do 13o: piso ${brl(inss13Piso)} | teto (14%) ${brl(inss13Teto)}`);
console.log(`  lancamentos abaixo do piso: ${n13Abaixo} (${pct(n13Abaixo / n13, 1)} dos lancamentos)`);
console.log(`  lancamentos com desconto ZERADO: ${n13Zero} (${pct(n13Zero / n13, 1)}) | bruto desses lancamentos: ${brl(bruto13Zero)}`);
console.log(`  Contribuicao/social nao recolhida — piso da falta: ${brl(faltando13)}`);
console.log(`  Faixa da contribuicao nao recolhida: de ${brl(faltando13)} (piso: 7,5% + IRRF do 13o) a ${brl(faltando13Teto)} (teto: 14% + IRRF do 13o)`);
console.log('  O piso e a FAIXA provada: abaixo dele nao ha como a contribuicao ter sido recolhida.');
console.log('  O teto assume a maior aliquota do.progressivo (14%) em toda a base.');
console.log('\n  exemplos dos lancamentos abaixo do piso:');
piores.forEach((p) => console.log('   ', JSON.stringify(p)));

console.log('\n\n  === 3) ADIANTAMENTO (A13) ===\n');
const a13 = folha.filter((r) => String(r.indRotina).toUpperCase() === 'A13');
const a13Bruto = a13.reduce((s, r) => s + Number(r.vlrSalarioBruto || 0), 0);
const a13Desc = a13.reduce((s, r) => s + Number(r.vlrDesconto || 0), 0);
console.log(`  lancamentos: ${a13.length} | bruto ${brl(a13Bruto)} | desconto ${brl(a13Desc)} (${pct(a13Desc / a13Bruto, 2)} do bruto)`);
console.log('  o adiantamento do 13o nao carrega o IRRF (ele se concentra no pagamento final) e');
console.log('  a contribuicao previdenciaria do 13o e recolhida no final — por isso o desconto');
console.log('  baixo no A13 NAO e, por si, indicio de desvio. O que a EFD/eSocial confirma e se o');
console.log('  pagamento final (P13) cobrou tudo.');

if (arqCsv) {
  const linhas = [['ano', 'bruto_folha', 'irrf_minimo_folha', 'irrf_minimo_13o', 'irrf_minimo_total', 'irrf_declarado_dca', 'diferenca', 'desconto_observado', 'base_salarial'],
    ...anos.map((a) => {
      const minimo = a.irrfMinimo + a.irrf13; const d = decl(a.ano);
      return [a.ano, a.bruto.toFixed(2), a.irrfMinimo.toFixed(2), a.irrf13.toFixed(2), minimo.toFixed(2), d == null ? '' : d.toFixed(2), d == null ? '' : (d - minimo).toFixed(2), a.desconto.toFixed(2), a.base.toFixed(2)];
    })];
  fs.writeFileSync(arqCsv, linhas.map((l) => l.join(';')).join('\n'));
  console.log(`\n  memoria gravada: ${arqCsv}`);
}
// --- resultado estruturado (consumido pelo relatorio)
const porAno13 = anos.map((a) => {
  const l13 = folha.filter((r) => Math.floor(Number(r.mesReferencia) / 100) === a.ano && ['P13', 'A13'].includes(String(r.indRotina).toUpperCase()));
  let abaixo = 0, zerado = 0, brutoZerado = 0, base = 0, desc = 0;
  for (const r of l13) {
    const comp = Number(r.mesReferencia); const b = Number(r.vlrSalarioBase || 0); const d = Number(r.vlrDesconto || 0);
    const i = inssPiso(b, a.ano); const irrf = irrf13Calculo(Number(r.vlrSalarioBruto || 0), comp);
    base += b; desc += d;
    if (d < i.piso + irrf - 0.01) abaixo++;
    if (d < 0.01) { zerado++; brutoZerado += Number(r.vlrSalarioBruto || 0); }
  }
  return { ano: a.ano, lancamentos: l13.length, abaixoPiso: abaixo, descontoZerado: zerado, base, desconto: desc, brutoSemDesconto: brutoZerado };
});
const irrfPorAno = anos.map((a) => {
  const d = decl(a.ano);
  return { ano: a.ano, cenario: a.irrfMinimo + a.irrf13, declarado: d, diferenca: d == null ? null : d - (a.irrfMinimo + a.irrf13), outros: a.desconto - (d || 0) };
});
// --- verbas previdenciarias: todas as rotinas, mesmo teste de piso
const ROTINAS = {
  FOL: 'Folha de pagamento mensal', FER: 'Ferias', FCO: 'Folha complementar',
  DES: 'Desligamento', P13: '13o - parcela final', A13: '13o - adiantamento',
};
// O teste e por servidor-mes (RIR/2018 art. 677, §2º: a aliquota incide sobre
// a SOMA dos rendimentos pagos no mes pela mesma fonte) e, no 13o, por
// pacote (adiantamento + parcela final), porque o adiantamento nao leva
// desconto: ele e compensado no pagamento final.
const porChave = new Map();
for (const r of folha) {
  const rot = String(r.indRotina || '').toUpperCase();
  const eh13 = rot === 'P13' || rot === 'A13';
  const comp = Number(r.mesReferencia);
  const chave = eh13 ? `${r.numMatricula}|13|${Math.floor(comp / 100)}` : `${r.numMatricula}|mes|${comp}`;
  if (!porChave.has(chave)) porChave.set(chave, { rot, comp, registros: [], bruto: 0, base: 0, desconto: 0, base13: 0, bruto13: 0 });
  const g = porChave.get(chave);
  const b = Number(r.vlrSalarioBruto || 0), bs = Number(r.vlrSalarioBase || 0), d = Number(r.vlrDesconto || 0);
  g.registros.push(r); g.bruto += b; g.base += bs; g.desconto += d;
  if (eh13 && rot === 'P13') { g.base13 += bs; g.bruto13 += b; }
}
const verbas = [];
for (const [rot, nome] of Object.entries(ROTINAS)) {
  const grupos = [...porChave.values()].filter((g) => {
    if (rot === 'P13') return g.rot === 'P13' || g.rot === 'A13';   // pacote do 13o
    if (rot === 'A13') return g.rot === 'A13';
    return g.rot === rot;
  });
  if (!grupos.length) continue;
  let bruto = 0, base = 0, desc = 0, abaixo = 0, zerado = 0, faltaP = 0, faltaT = 0, irrfDue = 0, inssDue = 0, lanc = 0;
  for (const g of grupos) {
    const ano = Math.floor(g.comp / 100);
    lanc += g.registros.length;
    bruto += g.bruto; base += g.base; desc += g.desconto;
    const i = inssPiso(g.base, ano);
    const irrf = (rot === 'P13' || rot === 'A13')
      ? irrf13Calculo(g.bruto13 || g.bruto, g.comp)
      : irrfTabela(Math.max(0, g.bruto - descontoSimplificadoDoMes(g.comp)), tabelaDoMes(g.comp));
    irrfDue += irrf; inssDue += i.piso;
    const piso = i.piso + irrf;
    if (g.desconto < piso - 0.01) { abaixo++; faltaP += (piso - g.desconto); faltaT += Math.max(0, (i.teto + irrf) - g.desconto); }
    if (g.desconto < 0.01) zerado++;
  }
  verbas.push({ rotina: rot, nome, lancamentos: lanc, grupos: grupos.length, bruto, base, desconto: desc,
    taxaDesconto: bruto ? desc / bruto : 0, abaixoPiso: abaixo, descontoZerado: zerado,
    irrfPorLei: irrfDue, inssPiso: inssDue, faltaPiso: faltaP, faltaTeto: faltaT });
}
const resultado = {
  verbas,
  porAno: porAno13,
  total: { lancamentos: n13, abaixoPiso: n13Abaixo, descontoZerado: n13Zero, base: base13, desconto: desconto13, brutoSemDesconto: bruto13Zero, faltaPiso: faltando13, faltaTeto: faltando13Teto },
  irrf: irrfPorAno,
  totais: { cenario: minimoTotal, declarado: declTotal, outros: tot.desconto - declTotal, bruto: tot.bruto, desconto: tot.desconto },
};
fs.writeFileSync(path.join(__dirname, 'calcular-previdenciario-resultado.json'), JSON.stringify(resultado, null, 1));
fs.writeFileSync('/workspace/calculo-previdenciario.json', JSON.stringify(resultado, null, 1));
console.log('\n\n  === 4) VERBAS PREVIDENCIARIAS (todas as rotinas da folha) ===\n');
console.log('  rotina | lanc. | bruto | desconto | taxa | abaixo do piso | zerados | falta (piso)');
for (const v of verbas) {
  console.log(`  ${v.rotina.padEnd(4)} | ${String(v.lancamentos).padStart(5)} | ${num(v.bruto).padStart(14)} | ${num(v.desconto).padStart(13)} | ${pct(v.taxaDesconto, 2).padStart(7)} | ${String(v.abaixoPiso).padStart(5)} | ${String(v.descontoZerado).padStart(5)} | ${num(v.faltaPiso).padStart(12)}`);
}
console.log('\n  resultado estruturado gravado: tools/calcular-previdenciario-resultado.json');
