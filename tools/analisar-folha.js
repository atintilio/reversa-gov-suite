// Ferramenta do Reversa Gov: coleta a folha de pagamento publica do portal de
// transparencia do municipio (plataforma PublicEnter) e devolve o agregado por
// competencia. Sem dado pessoal: o que sai daqui e agregado.
//
//   FOLHA_DE=2021-01-01 FOLHA_ATE=2025-12-31 PORTAL_BASE=https://<portal> PORTAL_ADM=1 \
//     node tools/coletar-folha-portal.js
//
// Analise da folha publica de Tupaciguara (5 anos): competencias, 13o, populacao, descontos.
const fs = require('fs');
const dados = JSON.parse(fs.readFileSync('/workspace/folha-tupaciguara-5anos.json', 'utf8'));
const brl = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = (v) => (v == null ? 'n/a' : (v * 100).toFixed(2) + '%');

console.log('  registros:', dados.length);

// 1) competencias (mesReferencia) e rotinas
const comps = new Map();
for (const r of dados) {
  const c = r.mesReferencia;
  if (!comps.has(c)) comps.set(c, { comp: c, n: 0, bruto: 0, base: 0, desc: 0, liq: 0, rotinas: new Map(), tipos: new Map() });
  const x = comps.get(c);
  x.n++;
  x.bruto += Number(r.vlrSalarioBruto || 0);
  x.base += Number(r.vlrSalarioBase || 0);
  x.desc += Number(r.vlrDesconto || 0);
  x.liq += Number(r.vlrSalarioLiquido || 0);
  const rot = r.indRotina || 'SEM';
  x.rotinas.set(rot, (x.rotinas.get(rot) || 0) + 1);
  const tip = r.desTipoClassificacao || 'SEM';
  x.tipos.set(tip, (x.tipos.get(tip) || 0) + 1);
}
const lista = [...comps.values()].sort((a, b) => a.comp - b.comp);
console.log('  competencias distintas:', lista.length, '| de', lista[0].comp, 'a', lista[lista.length - 1].comp);

// 2) o 13o: registros com rotina P13/A13
const treze = dados.filter((r) => ['P13', 'A13'].includes(r.indRotina));
const porAno13 = new Map();
for (const r of treze) {
  const ano = Math.floor(r.mesReferencia / 100);
  if (!porAno13.has(ano)) porAno13.set(ano, { n: 0, bruto: 0, base: 0, desc: 0, rotinas: new Set() });
  const x = porAno13.get(ano);
  x.n++; x.bruto += Number(r.vlrSalarioBruto || 0); x.base += Number(r.vlrSalarioBase || 0); x.desc += Number(r.vlrDesconto || 0);
  x.rotinas.add(r.indRotina);
}
console.log('\n  LANCAMENTOS DE DECIMO TERCEIRO (rotinas P13/A13)');
for (const [ano, x] of [...porAno13].sort()) {
  console.log(`   ${ano}: ${String(x.n).padStart(4)} lancamentos | rotinas ${[...x.rotinas].join('/')} | bruto ${brl(x.bruto).padStart(13)} | base ${brl(x.base).padStart(13)} | descontos ${brl(x.desc).padStart(12)}`);
}
const lancamentos13 = porAno13.size;
console.log(`  -> ${lancamentos13} anos com 13o | competencias de apuracao (modelo eSocial): ${lista.length} nominais + ${lancamentos13} de 13o = ${lista.length + lancamentos13}`);

// 3) competencia a competencia: servidores, bruto, descontos
console.log('\n  COMPETENCIA A COMPETENCIA');
console.log('  comp    | servidores | bruto             | salario base     | descontos        | desc/bruto | rotinas');
for (const x of lista) {
  const rot = [...x.rotinas.keys()].sort().join(',');
  console.log(`  ${x.comp} | ${String(x.n).padStart(10)} | ${brl(x.bruto).padStart(16)} | ${brl(x.base).padStart(16)} | ${brl(x.desc).padStart(16)} | ${(x.bruto ? pct(x.desc / x.bruto) : 'n/a').padStart(9)} | ${rot}`);
}

// 4) por ano
console.log('\n  POR ANO');
const porAno = new Map();
for (const x of lista) {
  const a = Math.floor(x.comp / 100);
  if (!porAno.has(a)) porAno.set(a, { comps: 0, servidores: 0, bruto: 0, base: 0, desc: 0 });
  const y = porAno.get(a);
  y.comps++; y.servidores = x.n; y.bruto += x.bruto; y.base += x.base; y.desc += x.desc;
}
for (const [a, y] of [...porAno].sort()) {
  console.log(`  ${a}: ${String(y.comps).padStart(2)} competencias | servidores (dez) ${String(y.servidores).padStart(4)} | bruto ${brl(y.bruto).padStart(15)} | base ${brl(y.base).padStart(15)} | descontos ${brl(y.desc).padStart(14)} | aliq.desconto ${pct(y.desc / y.bruto)}`);
}
const tBruto = lista.reduce((s, x) => s + x.bruto, 0);
const tDesc = lista.reduce((s, x) => s + x.desc, 0);
const tBase = lista.reduce((s, x) => s + x.base, 0);
console.log(`\n  TOTAL 5 ANOS: bruto ${brl(tBruto)} | base ${brl(tBase)} | descontos ${brl(tDesc)} | aliq. de desconto ${pct(tDesc / tBruto)}`);

// 5) populacao por tipo
const tipos = new Map();
for (const r of dados) { const t = r.desTipoClassificacao || 'SEM'; tipos.set(t, (tipos.get(t) || 0) + 1); }
console.log('\n  REGISTROS POR TIPO (5 anos, todas as competencias):');
for (const [t, n] of [...tipos].sort((a, b) => b[1] - a[1])) console.log(`   ${t.padEnd(30)} ${n}`);

// 6) 13o: o desconto do 13o (INSS) por ano e a relacao com a folha
console.log('\n  DECIMO TERCEIRO: antecipao vs folha mensal (base da rotina 13o x folha de dezembro)');
for (const [ano, x] of [...porAno13].sort()) {
  const dez = comps.get(ano * 100 + 12);
  const folhaMensal = dez ? dez.n : 0;
  console.log(`   ${ano}: lancamentos 13o ${String(x.n).padStart(4)} | servidores na competencia de dezembro ${String(folhaMensal).padStart(4)} | bruto 13o ${brl(x.bruto).padStart(12)} | desconto 13o ${brl(x.desc).padStart(11)} | aliq. desconto no 13o ${pct(x.desc / x.bruto)}`);
}
