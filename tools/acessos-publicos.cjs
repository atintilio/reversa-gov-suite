#!/usr/bin/env node
// ---------------------------------------------------------------------------
// acessos-publicos.cjs — consultas às fontes públicas da Prefeitura de
// Tupaciguara/MG (CNPJ 18.260.489/0001-04), conforme roteiro de coleta.
//
// Objetivo desta etapa: APRESENTAR OS ACESSOS e AJUSTAR A ESTRATÉGIA de
// consulta, com registro de: endereço da fonte, filtros, data da consulta,
// período de referência e resultado classificado como:
//   [OBTIDO] dado obtido  [ALTERNATIVA] fonte alternativa usada
//   [PENDENTE] consulta pendente (CAPTCHA)  [FALHA] falha de acesso
//
// Nada de dado fictício: cada número sai da fonte, com a URL e a data.
//
// Uso: node tools/acessos-publicos.cjs [--saida DIR]
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const CNPJ = '18260489000104';
const IBGE = '3169604';
const DATA_CONSULTA = new Date().toISOString().slice(0, 10);
const SAIDA = process.argv.includes('--saida')
  ? process.argv[process.argv.indexOf('--saida') + 1]
  : '/workspace/acessos';

fs.mkdirSync(SAIDA, { recursive: true });

const log = (...a) => console.log(...a);
const num = (v) => (typeof v === 'number' ? v : Number(String(v ?? 0).replace(/\./g, '').replace(',', '.')) || 0);

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'reversa-gov-suite/1.0' }, ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function getStatus(url, opts = {}) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, ...opts });
    return { status: r.status, bytes: (await r.text()).length };
  } catch (e) {
    return { status: 0, bytes: 0, erro: e.message };
  }
}

// ---------------------------------------------------------------------------
// 1. PNCP — contratos do município (fonte dos serviços contratados)
//    Cobertura: a plataforma é obrigatória desde abr/2024 (Lei 14.133/2021
//    + DNU 1.516/2024), logo 2021-2023 não têm contratos publicados.
// ---------------------------------------------------------------------------
async function pncp() {
  const url = (ini, fim) =>
    `https://pncp.gov.br/api/consulta/v1/contratos?dataInicial=${ini}&dataFinal=${fim}` +
    `&cnpjOrgao=${CNPJ}&pagina=1&tamanhoPagina=500`;
  const janelas = [['20240101', '20241231', '2024'], ['20250101', '20251231', '2025'], ['20260101', '20261026', '2026']];
  const mapa = new Map();
  const evidencia = [];
  for (const [ini, fim, rot] of janelas) {
    try {
      const j = await getJSON(url(ini, fim));
      evidencia.push({ janela: `${ini}-${fim}`, totalRegistros: j.totalRegistros, itens: (j.data || []).length });
      for (const x of j.data || []) mapa.set(x.numeroControlePNCP, x);
    } catch (e) {
      evidencia.push({ janela: `${ini}-${fim}`, erro: e.message });
    }
  }
  // pré-2024: confirmar ausência com a API (não presumir)
  let pre2024 = 'não consultado';
  try {
    const j = await getJSON(url('20210101', '20231231'));
    pre2024 = `${j.totalRegistros ?? (j.data || []).length} registros`;
  } catch (e) { pre2024 = `falha: ${e.message}`; }

  const contratos = [...mapa.values()];
  // valor ANUALIZADO dentro da vigência: proporcional aos meses de sobreposição
  const meses = (a, b) => {
    if (!a) return 0;
    const [ya, ma, da] = a.split('-').map(Number), [yb, mb, db] = (b || a).split('-').map(Number);
    return Math.max(0, (yb - ya) * 12 + (mb - ma) + (db >= da ? 1 : 0));
  };
  const SER = /servi[cç]o|prest(a|á)ção|consultoria|honor[aá]rio|manuten|loca[cç][aã]o de|arrendamento/i;
  const FORN = /fornecimento de|aquisi[cç][aã]o de|combust|delivery|execu[cç][aã]o de obras/i;
  const porAno = {};
  for (const x of contratos) {
    const y = x.anoContrato; if (!y) continue;
    const obj = String(x.objetoContrato || '');
    const v = num(x.valorInicial);
    const ini = x.dataVigenciaInicio, fim = x.dataVigenciaFim;
    const mTot = meses(ini, fim); if (!mTot) continue;
    const mAno = Math.max(0, Math.min(mTot, (fim || ini).slice(0, 4) === String(y)
      ? (Number(fim.slice(0, 4)) - y) * 12 + (Number(fim.slice(5, 7)) - Number(ini.slice(5, 7))) + 1
      : mTot));
    const anual = v * (mAno / mTot);
    const d = (porAno[y] = porAno[y] || { servicos: 0, contratosServicos: 0, total: 0, contratos: 0, itens: [] });
    d.total += v; d.contratos++;
    if (SER.test(obj) && !FORN.test(obj)) { d.servicos += anual; d.contratosServicos++; d.itens.push({ anual, objeto: obj, valorContrato: v, inicio: ini, fim }); }
  }
  return { contratos: contratos.length, evidencia, pre2024, porAno };
}

// ---------------------------------------------------------------------------
// 2. TCU — responsáveis por contas julgadas irregulares
// ---------------------------------------------------------------------------
async function tcu() {
  try {
    const r = await fetch('https://certidoes.apps.tcu.gov.br/api/publico/responsaveis-contas-irregulares', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uf: 'MG', municipio: 'TUPACIGUARA' }),
    });
    if (!r.ok) return { status: r.status, registros: [] };
    const registros = await r.json();
    return { status: r.status, registros };
  } catch (e) { return { status: 0, erro: e.message, registros: [] }; }
}

// ---------------------------------------------------------------------------
// 3. CAPMG / CadPrev — verificação de disponibilidade (sem contornar CAPTCHA)
// ---------------------------------------------------------------------------
async function disponibilidade() {
  const out = {};
  for (const [nome, url] of [
    ['CAPMG (cidadão)', 'https://capmg.tce.mg.gov.br/'],
    ['CadPrev (consulta pública)', 'https://cadprev.previdencia.gov.br/Cadprev/pages/index.xhtml'],
    ['Portal municipal de pessoal', 'https://transparencia.tupaciguara.mg.gov.br/publico/servidor?codCargo=0&indSituacao=null&datAberturaInicio=2025-01-01&datAberturaFim=2025-01-31&codAdministracao=1&maxResultados=20&elementosPorPagina=20&pagina=1&ordenarPor=nomServidor'],
    ['Catálogo oficial RPPS (gov.br)', 'https://www.gov.br/previdencia/pt-br/assuntos/rpps/estatisticas-e-informacoes-dos-rpps-1/estatisticas-informacoes-dos-rpps'],
    ['Pasta oficial de CRP (Serpro)', 'https://serprodrive.serpro.gov.br/s/eBL9i5k6c4FxZtS'],
  ]) out[nome] = await getStatus(url);
  return out;
}

// ---------------------------------------------------------------------------
(async () => {
  log('\n=== PNCP — contratos (cnpjOrgao=' + CNPJ + ') ===');
  const p = await pncp();
  log('  contratos únicos:', p.contratos, '| 2021-2023:', p.pre2024);
  for (const y of Object.keys(p.porAno).sort()) {
    const d = p.porAno[y];
    log(`  anoContrato ${y}: ${d.contratos} contratos | R$ ${d.total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} | piso de base de SERVIÇOS R$ ${d.servicos.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} (${d.contratosServicos} contratos)`);
  }
  log('\n=== TCU — responsáveis por contas irregulares (uf=MG, municipio=TUPACIGUARA) ===');
  const t = await tcu();
  log('  HTTP', t.status, '| registros:', (t.registros || []).length);
  for (const r of t.registros || []) log(`   - processo ${r.numeroProcessoFormatado} | ${r.nome} | trânsito ${r.dataTransitoEmJulgado} | acórdão ${r.numeroAcordaoFormatado}`);
  log('\n=== disponibilidade das fontes ===');
  const disp = await disponibilidade();
  for (const [k, v] of Object.entries(disp)) log(`  [${v.status || 'ERRO'}] ${k}`);

  const saida = { dataConsulta: DATA_CONSULTA, cnpj: CNPJ, ibge: IBGE, pncp: p, tcu: t, disponibilidade: disp };
  fs.writeFileSync(path.join(SAIDA, 'acessos-publicos.json'), JSON.stringify(saida, null, 1));
  log('\n  gravado: ' + path.join(SAIDA, 'acessos-publicos.json'));
})();
