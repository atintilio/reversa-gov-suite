// Ferramenta do Reversa Gov: coleta a folha de pagamento publica do portal de
// transparencia do municipio (plataforma PublicEnter) e devolve o agregado por
// competencia. Sem dado pessoal: o que sai daqui e agregado.
//
//   FOLHA_DE=2021-01-01 FOLHA_ATE=2025-12-31 PORTAL_BASE=https://<portal> PORTAL_ADM=1 \
//     node tools/coletar-folha-portal.js
//
// Baixa a folha de pagamento publica do portal (janela de 5 anos) e mede as competencias.
const fs = require('fs');

const BASE = process.env.PORTAL_BASE || 'https://transparencia.tupaciguara.mg.gov.br';
const ADM = process.env.PORTAL_ADM || '1';
const DE = process.env.FOLHA_DE || '2021-01-01';
const ATE = process.env.FOLHA_ATE || '2025-12-31';
const PAGINA = 2000;

async function pagina(n) {
  const u = `${BASE}/publico/servidor?codCargo=0&indSituacao=null&datAberturaInicio=${DE}&datAberturaFim=${ATE}&codAdministracao=${ADM}`
    + `&maxResultados=${PAGINA}&elementosPorPagina=${PAGINA}&pagina=${n}&ordenarPor=nomServidor`;
  const r = await fetch(u, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} na pagina ${n}`);
  return r.json();
}

(async () => {
  // ano a ano: a API nao aguenta a janela de 5 anos de uma vez (HTTP 500)
  const todos = [];
  for (let ano = 2021; ano <= 2025; ano++) {
    const ini = `${ano}-01-01`, fim = `${ano}-12-31`;
    const u = `${BASE}/publico/servidor?codCargo=0&indSituacao=null&datAberturaInicio=${ini}&datAberturaFim=${fim}&codAdministracao=${ADM}`
      + `&maxResultados=${PAGINA}&elementosPorPagina=${PAGINA}&pagina=1&ordenarPor=nomServidor`;
    const r0 = await fetch(u, { headers: { Accept: 'application/json' } });
    if (!r0.ok) { console.log(`  ${ano}: HTTP ${r0.status} (pulando)`); continue; }
    const p0 = await r0.json();
    const paginas = Number(p0.totalPages || 1);
    const anoRecs = (p0.content || []).slice();
    for (let p = 1; p < paginas; p++) {
      const u2 = u.replace('pagina=1', 'pagina=' + (p + 1));
      const j = await (await fetch(u2, { headers: { Accept: 'application/json' } })).json();
      anoRecs.push(...(j.content || []));
      await new Promise((r) => setTimeout(r, 400));
    }
    console.log(`  ${ano}: ${anoRecs.length} registros (${paginas} paginas)`);
    todos.push(...anoRecs);
    await new Promise((r) => setTimeout(r, 600));
  }
  fs.writeFileSync('/workspace/folha-tupaciguara-5anos.json', JSON.stringify(todos));
  console.log(`  salvo: folha-tupaciguara-5anos.json (${todos.length} registros)`);

  // competencias
  const comps = new Map();
  for (const r of todos) {
    const c = r.mesReferencia;
    if (!comps.has(c)) comps.set(c, { n: 0, bruto: 0, base: 0, desconto: 0, tipos: new Set(), rotinas: new Set() });
    const x = comps.get(c);
    x.n++;
    x.bruto += Number(r.vlrSalarioBruto || 0);
    x.base += Number(r.vlrSalarioBase || 0);
    x.desconto += Number(r.vlrDesconto || 0);
    if (r.desTipoClassificacao) x.tipos.add(r.desTipoClassificacao);
    if (r.indRotina) x.rotinas.add(r.indRotina);
  }
  const lista = [...comps.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  console.log(`\n  COMPETENCIAS DISTINTAS: ${lista.length}`);
  console.log('  primeiro:', lista[0][0], '| ultimo:', lista[lista.length - 1][0]);
  const com13 = lista.filter(([c, x]) => x.rotinas.has('13') || [...x.tipos].some((t) => /13/i.test(t)));
  console.log(`  competencias com marcador de 13o: ${com13.length}`);
  const rotinas = new Set(), tipos = new Set();
  for (const [, x] of lista) { for (const t of x.rotinas) rotinas.add(t); for (const t of x.tipos) tipos.add(t); }
  console.log('  rotinas (indRotina):', [...rotinas].join(', '));
  console.log('  tipos (desTipoClassificacao):', [...tipos].join(', '));
  console.log('\n  amostra de 8 competencias:');
  for (const [c, x] of lista.slice(0, 4).concat(lista.slice(-4))) {
    console.log(`   ${c} | servidores ${String(x.n).padStart(4)} | bruto ${x.bruto.toFixed(2).padStart(14)} | base ${x.base.toFixed(2).padStart(14)} | desconto ${x.desconto.toFixed(2).padStart(12)} | rotinas ${[...x.rotinas].join('/')}`);
  }
  // soma anual
  console.log('\n  por ano:');
  const porAno = new Map();
  for (const [c, x] of lista) { const a = String(c).slice(0, 4); const y = porAno.get(a) || { comps: 0, bruto: 0, desc: 0 }; y.comps++; y.bruto += x.bruto; y.desc += x.desconto; porAno.set(a, y); }
  for (const [a, y] of [...porAno].sort()) console.log(`   ${a}: ${String(y.comps).padStart(3)} competencias | bruto ${y.bruto.toFixed(2).padStart(16)} | descontos ${y.desc.toFixed(2).padStart(14)}`);
})();
