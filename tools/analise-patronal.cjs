#!/usr/bin/env node
/**
 * analise-patronal.cjs — cross-check between the payroll (public sheet) and the
 * patronal obligations recorded in the Siconfi/DCA of the municipality.
 *
 * WHY: the diagnosis of the servers' contribution (what was withheld from the
 * server) is only one side. The other side is the PATRONAL: what the entity
 * paid to the regime (RPPS and/or RGPS) over the period. The DCA carries:
 *   3.1.90.01.00  Aposentadorias do RPPS, Reserva Remunerada e Reformas dos Militares
 *   3.1.90.03.00  Pensões do RPPS e do Militar
 *   3.1.90.04.00  Contratação por Tempo Determinado
 *   3.1.90.11.00  Vencimentos e Vantagens Fixas - Pessoal Civil
 *   3.1.90.13.00  Obrigações Patronais  (13.01 = RGPS, 13.02 = RPPS, 13.99 = outras)
 *   3.1.90.94.00  Indenizações e Restituições Trabalhistas
 *
 * WHAT IT DOES: for each exercise it puts the payroll base (salario_base of the
 * public sheet) next to what the DCA says was paid as patronal, and flags the
 * exercises where the patronal ratio breaks the series.
 *
 * WHAT IT DOES NOT DO: it does not assert that a difference is a debt. The DCA
 * line is an accounting record of the expense, not proof of payment to the
 * regime. Closing the gap requires the regime's own evidence (CRP/CadPrev,
 * eSocial, the RPPS's own statements) — see the "lacunas" section of the report.
 *
 * Usage: node tools/analise-patronal.cjs [dca.json] [folha.csv] [out.json]
 */
const fs = require('fs');
const path = require('path');

const DCA = process.argv[2] || '/workspace/dca-completa-5anos.json';
const FOLHA = process.argv[3] || '/workspace/output/FOLHA_TUPACIGUARA_AGREGADA_5ANOS.csv';
const OUT = process.argv[4] || path.join(__dirname, 'analise-patronal-resultado.json');
const ANOS = ['2021', '2022', '2023', '2024', '2025'];

/** DCA values come with a dot as the decimal separator (e.g. 8544435.46). */
function num(x) {
  const s = String(x == null ? '' : x).trim();
  if (!s) return 0;
  if (s.includes(',')) return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
  return parseFloat(s) || 0;
}

const CONTA = {
  pessoal: 'DO3.1.90.11.00.00',
  patronal: 'DO3.1.90.13.00.00',
  patronalRgps: 'DO3.1.90.13.01.00.00',
  patronalRpps: 'DO3.1.90.13.02.00.00',
  patronalOutras: 'DO3.1.90.13.99.00.00',
  clt: 'DO3.1.90.04.00.00',
  rppsAposent: 'DO3.1.90.01.00.00',
  rppsPensoes: 'DO3.1.90.03.00.00',
};

function dcaPorAno() {
  const dca = JSON.parse(fs.readFileSync(DCA, 'utf8'));
  const out = {};
  for (const ano of ANOS) {
    const linhas = Array.isArray(dca[ano]) ? dca[ano] : (dca[ano] || []);
    const acc = Object.fromEntries(Object.keys(CONTA).map((k) => [k, 0]));
    const colunas = new Set();
    for (const r of linhas) {
      const c = String(r.cod_conta || '');
      if (!Object.values(CONTA).includes(c)) continue;
      colunas.add(r.coluna);
      if (r.coluna !== 'Despesas Pagas') continue; // the base of the retention is the payment
      for (const [k, cod] of Object.entries(CONTA)) if (cod === c) acc[k] += num(r.valor);
    }
    out[ano] = { ...acc, colunas: [...colunas] };
  }
  return out;
}

function folhaPorAno() {
  const texto = fs.readFileSync(FOLHA, 'utf8').trim();
  const linhas = texto.split('\n');
  const cab = linhas[0].split(';');
  const idx = Object.fromEntries(cab.map((c, i) => [c.trim(), i]));
  const out = {};
  for (const linha of linhas.slice(1)) {
    if (!linha.trim()) continue;
    const p = linha.split(';');
    const ano = p[idx.ano];
    if (!out[ano]) out[ano] = { bruto: 0, base: 0, descontos: 0, registros: 0 };
    out[ano].bruto += parseFloat(p[idx.bruto]) || 0;
    out[ano].base += parseFloat(p[idx.salario_base]) || 0;
    out[ano].descontos += parseFloat(p[idx.descontos]) || 0;
    out[ano].registros += parseInt(p[idx.registros], 10) || 0;
  }
  return out;
}

const dca = dcaPorAno();
const folha = folhaPorAno();
const serie = [];

for (const ano of ANOS) {
  const d = dca[ano] || {};
  const f = folha[ano] || { bruto: 0, base: 0, descontos: 0, registros: 0 };
  const denomPessoal = (d.pessoal || 0) + (d.clt || 0);
  const razao = denomPessoal ? (d.patronal || 0) / denomPessoal : 0;
  serie.push({
    ano,
    folha: {
      registros: f.registros,
      brutoReais: round(f.bruto),
      baseContribuicaoReais: round(f.base),
      descontosReais: round(f.descontos),
    },
    dcaDespesasPagas: {
      vencimentosPessoalCivilReais: round(d.pessoal),
      contratacaoTempoDeterminadoReais: round(d.clt),
      obrigacoesPatronaisReais: round(d.patronal),
      patronalRgpsReais: round(d.patronalRgps),
      patronalRppsReais: round(d.patronalRpps),
      patronalOutrasReais: round(d.patronalOutras),
      aposentadoriasRppsReais: round(d.rppsAposent),
      pensoesRppsReais: round(d.rppsPensoes),
    },
    razaoPatronalSobrePessoal: pct(razao),
    patronalSobreBaseDaFolha: pct(d.patronal ? d.patronal / (f.base || 1) : 0),
    indicio: indicio(ano, razao, d),
  });
}

function round(v) { return Math.round((v || 0) * 100) / 100; }
function pct(v) { return Math.round((v || 0) * 10000) / 100; }

/**
 * Flag the exercises that break the series. The ratio patronal/(pessoal civil +
 * CLT) was stable around 19%-22% in the first exercises; an exercise that falls
 * far below is a candidate for a recording/payment gap.
 */
function indicio(ano, razao, d) {
  const serie_ = [0.1904, 0.1972, 0.2213];
  const med = serie_.reduce((a, b) => a + b, 0) / serie_.length;
  if (!d.patronal) {
    return {
      nivel: 'ALTO',
      texto: 'Obrigacoes Patronais zeradas no DCA (Despesas Pagas) — anomalia de registro ou de recolhimento a confirmar.',
    };
  }
  if (razao < med * 0.7) {
    return {
      nivel: 'ALTO',
      texto: `Razao patronal/pessoal de ${pct(razao)}% contra ~${pct(med)}% da serie 2021-2023 — queda acima da variacao da folha.`,
    };
  }
  if (razao < med * 0.85) {
    return {
      nivel: 'MEDIO',
      texto: `Razao patronal/pessoal de ${pct(razao)}% abaixo da serie (~${pct(med)}%) — verificar.`,
    };
  }
  return { nivel: 'SEM_INDICIO', texto: 'Razao patronal/pessoal compativel com a serie.' };
}

const resultado = {
  geradoEm: new Date().toISOString(),
  fonteDca: DCA,
  fonteFolha: FOLHA,
  colunaDcaUsada: 'Despesas Pagas',
  serie,
  alertas: serie.filter((s) => s.indicio.nivel !== 'SEM_INDICIO'),
  ressalvas: [
    'A linha 3.1.90.13.00 do DCA e registro contabeis de despesa; nao e prova de recolhimento ao regime.',
    'O denominador (11.00 + 04.00) inclui os contratados por tempo determinado, que tem base de contribuicao propria.',
    'As series do DCA e da folha publica nao tem o mesmo perimetro de servidores; a razao e um indicador de serie, nao uma apuracao.',
    'A definicao do regime (RPPS e/ou RGPS) e a aliquota patronal aplicavel precisam de confirmacao no CadPrev/CRP e no eSocial.',
  ],
};

fs.writeFileSync(OUT, JSON.stringify(resultado, null, 2), 'utf8');

console.log('ano  |  base folha     |  patronal DCA   |  razao |  nivel');
for (const s of serie) {
  console.log(
    `${s.ano} | ${String(s.folha.baseContribuicaoReais.toLocaleString('pt-BR', { minimumFractionDigits: 2 })).padStart(15)} | ` +
    `${String(s.dcaDespesasPagas.obrigacoesPatronaisReais.toLocaleString('pt-BR', { minimumFractionDigits: 2 })).padStart(15)} | ` +
    `${String(s.razaoPatronalSobrePessoal).padStart(6)}% | ${s.indicio.nivel}`
  );
}
console.log(`\n-> ${OUT}`);
for (const a of resultado.alertas) console.log(`   [${a.indicio.nivel}] ${a.ano}: ${a.indicio.texto}`);
