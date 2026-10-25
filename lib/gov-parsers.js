// Reversa Gov — parsers de ingestion do modulo IRRF Municipal.
//
// Leem o documento no formato em que ele chega e devolvem uma estrutura
// neutra. Nenhuma regra juridica e aplicada aqui: o parser so extrai fatos
// (quem, quanto, qual CNR, qual data). A classificacao e o motor de regras
// (lib/domain/gov-irrf.js) que decide o que esses fatos significam.
//
// Formatos suportados:
//   - EFD-Reinf (flat file da Receita, registros separados por "|")
//   - ECD (Escrituracao Contabil Digital — reusa motor-ecd.js do Reversa Tax)
//   - Planilha de retencao (CSV ";" ou ","), com cabecalho flexivel

const crypto = require('node:crypto');

// ---------------------------------------------------------------- utilidades

function digitos(v) { return String(v == null ? '' : v).replace(/\D+/g, ''); }

function cnpj(v) {
  const d = digitos(v);
  return d.length === 14 ? d : null;
}

// Valor em reais -> centavos. Aceita "1.234,56", "1234.56", "1234,56".
function centavos(v) {
  if (v == null || v === '') return 0;
  let s = String(v).trim().replace(/R\$/gi, '').replace(/\s/g, '');
  if (!s) return 0;
  if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function dataBr(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{2})(\d{2})(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

// Competencia "05/2026" ou "2026-05" -> "2026-05"
function competencia(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[2]}-${String(m[1]).padStart(2, '0')}`;
  m = s.match(/^(\d{4})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}`;
  return null;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ------------------------------------------------------------------- formato

// Deteccao por nome e conteudo. A ordem importa: EFD-Reinf e ECD comecam com
// registro numerico; a planilha tem cabecalho textual.
function detectarFormato(nome, texto) {
  const n = String(nome || '').toLowerCase();
  const t = String(texto || '');
  if (/efd.?reinf/.test(n)) return 'efd_reinf';
  // Folha do município: eventos do eSocial (S-1000, S-1005, S-1010, S-1020,
  // S-1200, S-2299). O Gov nao apura INSS: quem apura e o Reversa Tax, que
  // tem o motor. Aqui basta reconhecer o arquivo e repassar.
  if (/<(\w+:)?eSocial[\s>]/.test(t)) return 'esocial';
  if (/\becd\b|ledc|lecd/.test(n)) return 'ecd';
  if (/darf|pagamento|recolhimento|guia|relatorio/.test(n)) return 'pagamentos';
  if (/retid|retenc|irrf|movimento/.test(n)) return 'csv';
  const linhas = t.split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 5);
  if (linhas.some((l) => /^\|?\s*\d{1,2}\|/.test(l))) {
    if (linhas.some((l) => /^\|?\s*0000\|/.test(l))) return 'ecd';
    return 'efd_reinf';
  }
  if (linhas.length && linhas[0].indexOf(';') >= 0) {
    const cabecalho = normalizarChave(linhas[0]);
    if (cabecalho.indexOf('codigoreceita') >= 0 || cabecalho.indexOf('valorrecolhido') >= 0
      || (cabecalho.indexOf('codigo') >= 0 && cabecalho.indexOf('valor') >= 0 && cabecalho.indexOf('datarecolhimento') >= 0)) return 'pagamentos';
    return 'csv';
  }
  return 'desconhecido';
}

// ------------------------------------------------------------------ planilha

const ALIAS = {
  cnpj: ['cnpj', 'cnpj_fornecedor', 'cnpj_prestador', 'cnpj_contratado', 'fornecedor_cnpj', 'prestador_cnpj', 'cnpj_da_empresa'],
  razaoSocial: ['razao_social', 'razaosocial', 'nome', 'fornecedor', 'prestador', 'empresa', 'razao social do fornecedor'],
  competencia: ['competencia', 'periodo', 'mes_competencia', 'competencia_retencao', 'periodo_retencao'],
  dataPagamento: ['data_pagamento', 'data', 'dt_pagamento', 'data_pagto', 'data do pagamento'],
  cnr: ['cnr', 'codigo_natureza', 'natureza', 'codigo_natureza_rendimento', 'natureza do rendimento'],
  base: ['base', 'base_retida', 'base_calculo', 'valor_base', 'base_de_calculo', 'base do imposto'],
  retido: ['valor_retido', 'retido', 'valor_irrf', 'irrf', 'valor_retenido', 'valor retido'],
  aliquota: ['aliq', 'aliquota', 'taxa', 'percentual', 'perc_retencao', 'aliquota_retencao'],
  destinatario: ['destinatario', 'destino', 'quem_recebeu', 'recebedor', 'titularidade', 'destinatario do valor'],
  obs: ['obs', 'observacao', 'observacoes', 'nota'],
};

function normalizarChave(txt) {
  return String(txt || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function mapearCabecalho(cabecalho) {
  const mapa = {};
  const chaves = Object.keys(ALIAS);
  cabecalho.forEach((titulo, i) => {
    const n = normalizarChave(titulo);
    for (const campo of chaves) {
      if (mapa[campo] != null) continue;
      if (ALIAS[campo].some((alias) => normalizarChave(alias) === n)) { mapa[campo] = i; return; }
    }
    for (const campo of chaves) {
      if (mapa[campo] != null) continue;
      if (ALIAS[campo].some((alias) => n.indexOf(normalizarChave(alias)) >= 0)) { mapa[campo] = i; return; }
    }
  });
  return mapa;
}

// CSV de retencao: uma linha por retencao.
function parseCsvRetido(texto) {
  const linhas = String(texto || '').split(/\r\n|\n|\r/).filter((l) => l.trim());
  if (!linhas.length) return { tipo: 'csv', linhas: [], avisos: ['Arquivo vazio.'] };
  const separador = (linhas[0].split(';').length >= linhas[0].split(',').length) ? ';' : ',';
  const cabecalho = linhas[0].split(separador);
  const mapa = mapearCabecalho(cabecalho);
  const avisos = [];
  if (mapa.cnpj == null) avisos.push('Sem coluna de CNPJ — nenhuma linha pôde ser lida.');
  if (mapa.retido == null && mapa.base == null) avisos.push('Sem coluna de valor retido ou de base — os valores vieram zerados.');

  const registros = [];
  for (let i = 1; i < linhas.length; i++) {
    const campos = linhas[i].split(separador);
    if (!campos.length || !campos.some((c) => c.trim())) continue;
    const pega = (campo) => (mapa[campo] != null ? String(campos[mapa[campo]] == null ? '' : campos[mapa[campo]]).trim() : '');
    const c = cnpj(pega('cnpj'));
    if (!c) { avisos.push(`Linha ${i + 1}: CNPJ ausente ou inválido — ignorada.`); continue; }
    registros.push({
      cnpj: c,
      razaoSocial: pega('razaoSocial') || null,
      competencia: competencia(pega('competencia')),
      dataPagamento: dataBr(pega('dataPagamento')),
      cnr: digitos(pega('cnr')) || null,
      baseCents: centavos(pega('base')),
      withheldCents: centavos(pega('retido')),
      rate: pega('aliquota') ? Number(String(pega('aliquota')).replace(',', '.').replace('%', '')) / 100 : null,
      destinatario: pega('destinatario') || null,
      obs: pega('obs') || null,
      linha: i + 1,
    });
  }
  return { tipo: 'csv', cabecalho, registros, avisos };
}

// ------------------------------------------- relatorio de pagamentos (DARF)
// O "relatorio de pagamentos" do sistema contabil e o que prova o repasse do
// IRRF a Uniao (DARF). Cada linha e um recolhimento.
const ALIAS_PAG = {
  codigo: ['codigo_receita', 'codigo', 'codigo_darf', 'receita', 'codigo_tributo'],
  data: ['data_recolhimento', 'data_pagamento', 'data', 'dt_recolhimento', 'data_vencimento'],
  valor: ['valor', 'valor_recolhido', 'valor_pago', 'valor_darf', 'valor_recolher', 'valor_irrf'],
  descricao: ['descricao', 'historico', 'histórico', 'observacao', 'memo'],
  cnpj: ['cnpj', 'cnpj_estabelecimento', 'cnpj_contribuinte', 'estabelecimento'],
  numero: ['numero', 'numero_darf', 'darf', 'referencia'],
};

function mapearPagamento(cabecalho) {
  const mapa = {};
  const chaves = Object.keys(ALIAS_PAG);
  cabecalho.forEach((titulo, i) => {
    const n = normalizarChave(titulo);
    for (const campo of chaves) {
      if (mapa[campo] != null) continue;
      if (ALIAS_PAG[campo].some((a) => normalizarChave(a) === n)) { mapa[campo] = i; return; }
    }
    for (const campo of chaves) {
      if (mapa[campo] != null) continue;
      if (ALIAS_PAG[campo].some((a) => n.indexOf(normalizarChave(a)) >= 0)) { mapa[campo] = i; return; }
    }
  });
  return mapa;
}

function parseRelatorioPagamentos(texto) {
  const linhas = String(texto || '').split(/\r\n|\n|\r/).filter((l) => l.trim());
  if (!linhas.length) return { tipo: 'pagamentos', pagamentos: [], avisos: ['Arquivo vazio.'] };
  const separador = (linhas[0].split(';').length >= linhas[0].split(',').length) ? ';' : ',';
  const cabecalho = linhas[0].split(separador);
  const mapa = mapearPagamento(cabecalho);
  const avisos = [];
  if (mapa.valor == null) avisos.push('Sem coluna de valor — nada foi lido.');
  const pagamentos = [];
  for (let i = 1; i < linhas.length; i++) {
    const campos = linhas[i].split(separador);
    if (!campos.length || !campos.some((c) => c.trim())) continue;
    const pega = (campo) => (mapa[campo] != null ? String(campos[mapa[campo]] == null ? '' : campos[mapa[campo]]).trim() : '');
    const valor = centavos(pega('valor'));
    if (!valor) { avisos.push(`Linha ${i + 1}: valor ausente — ignorada.`); continue; }
    const codigo = digitos(pega('codigo'));
    const descricao = pega('descricao');
    // E IRRF: pelo codigo de receita (0561, 1091, 8301, 9649...) ou pelo
    // descricao. A lista de codigos e conferida no SIEF; na duvida, o
    // descricao manda.
    const pareceIrrf = /IRRF|IMPOSTO DE RENDA|RENDIMENTO/.test(descricao.toUpperCase())
      || ['0561', '1091', '8301', '9649', '3209', '3210'].includes(codigo);
    if (!pareceIrrf) continue;
    pagamentos.push({
      codigoReceita: codigo || null,
      data: dataBr(pega('data')),
      valorCents: valor,
      descricao: descricao || null,
      cnpj: cnpj(pega('cnpj')),
      numero: pega('numero') || null,
      linha: i + 1,
    });
  }
  if (!pagamentos.length) avisos.push('Nenhum recolhimento de IRRF identificado no relatorio.');
  return { tipo: 'pagamentos', cabecalho, pagamentos, avisos };
}

// --------------------------------------------------------------- EFD-Reinf

// Registro 1: identificacao do estabelecimento.
// Registro 4: pagamento.
// Registro 6: retencao (a que interessa).
// Registro 9: servico tomado (a base da retencao).
function parseEfdReinf(texto) {
  const avisos = [];
  const pagamentos = new Map();
  const retencoes = [];
  const servicos = new Map();
  let cnpjEstabelecimento = null;
  let cnpjContribuinte = null;
  let linhasLidas = 0;

  const chave = (grupo, pagamento) => `${grupo}|${pagamento}`;

  String(texto || '').split(/\r\n|\n|\r/).forEach((linha, idx) => {
    const l = linha.replace(/^﻿/, '').trim();
    if (!l) return;
    const p = l.split('|');
    const tipo = String(p[0] || '').trim();
    linhasLidas++;

    if (tipo === '1') {
      cnpjEstabelecimento = cnpj(p[1]) || cnpjEstabelecimento;
      cnpjContribuinte = cnpj(p[2]) || cnpjContribuinte;
      return;
    }
    if (tipo === '4') {
      const grupo = String(p[4] || '').trim();
      const pagamento = String(p[5] || '').trim();
      const data = dataBr(p[6]);
      const valor = centavos(p[7]);
      const receita = String(p[10] || '').trim() || null;
      if (!grupo && !pagamento) return;
      pagamentos.set(chave(grupo, pagamento), { grupo, pagamento, data, valor, receita });
      return;
    }
    if (tipo === '6') {
      const grupo = String(p[4] || '').trim();
      const pagamento = String(p[5] || '').trim();
      // O CNR ocupa a posicao 6 no leiaute; se nao for numerico de 5 digitos,
      // procura o primeiro campo numerico de 5 digitos da linha.
      let cnr = digitos(p[6]);
      if (!/^\d{5}$/.test(cnr)) {
        for (let i = 1; i < p.length; i++) {
          const d = digitos(p[i]);
          if (/^\d{5}$/.test(d)) { cnr = d; break; }
        }
      }
      const base = centavos(p[8]);
      const valor = centavos(p[9]);
      if (!valor && !base) { avisos.push(`Linha ${idx + 1}: retencao sem valor legivel.`); return; }
      retencoes.push({ grupo, pagamento, cnr: cnr || null, baseCents: base, withheldCents: valor, linha: idx + 1 });
      return;
    }
    if (tipo === '9') {
      const grupo = String(p[4] || '').trim();
      const pagamento = String(p[5] || '').trim();
      const prestador = cnpj(p[6]);
      const valor = centavos(p[7]);
      if (!prestador && !valor) return;
      servicos.set(chave(grupo, pagamento), { grupo, pagamento, prestador, valor });
    }
  });

  if (!retencoes.length) avisos.push('Nenhuma retencao encontrada no arquivo (registro tipo 6).');
  if (!cnpjEstabelecimento) avisos.push('Identificacao do estabelecimento (registro tipo 1) nao encontrada.');

  return {
    tipo: 'efd_reinf',
    cnpjEstabelecimento,
    cnpjContribuinte,
    pagamentos: Array.from(pagamentos.values()),
    retencoes,
    servicos: Array.from(servicos.values()),
    avisos,
    linhasLidas,
  };
}

// ---------------------------------------------------------------------- ECD

// Reusa o leitor do Reversa Tax (motor-ecd.js): le a ECD, sem aplicar tese.
function parseEcd(texto, nome) {
  const avisos = [];
  let lido;
  try {
    const MotorEcd = require('../motor-ecd.js');
    lido = MotorEcd.lerEcd(texto, nome || 'ecd.txt');
  } catch (error) {
    return { tipo: 'ecd', lancamentos: [], avisos: ['Falha ao ler a ECD: ' + (error.message || 'erro desconhecido').slice(0, 160)] };
  }
  (lido.avisos || []).slice(0, 20).forEach((a) => avisos.push(String(a)));
  const lancamentos = [];
  (lido.lancamentos || []).forEach((l) => {
    (l.partidas || []).forEach((p) => {
      lancamentos.push({
        numero: l.num || null,
        data: l.data || null,
        conta: p.conta || null,
        historico: p.hist || null,
        debitoCents: p.dc === 'D' ? Math.round(Number(p.valor || 0) * 100) : 0,
        creditoCents: p.dc === 'C' ? Math.round(Number(p.valor || 0) * 100) : 0,
      });
    });
  });
  return {
    tipo: 'ecd',
    cnpj: lido.cnpj || null,
    empresa: lido.empresa || null,
    competenciaInicio: lido.ini || null,
    competenciaFim: lido.fin || null,
    lancamentos,
    avisos,
  };
}

// Leitura leve dos eventos de folha do eSocial. O Gov nao calcula INSS: o
// motor preprocessarioario e do Reversa Tax. Aqui o que importa e reconhecer
// o arquivo, contar os eventos e dizer quais competencias vieram — o resto
// da folha segue intacta para ser repassada ao Tax.
const EVENTOS_ESO = [
  ['evtInfoEmpregador', 'S-1000', 'Dados do empregador'],
  ['evtTabEstab', 'S-1005', 'Estabelecimentos'],
  ['evtTabRubrica', 'S-1010', 'Tabela de rubricas'],
  ['evtTabLotacao', 'S-1020', 'Tabela de lotacoes'],
  ['evtRemun', 'S-1200', 'Remuneracao'],
  ['evtDeslig', 'S-2299', 'Desligamento'],
  ['evtExclusao', 'S-3000', 'Exclusao de evento'],
];

function parseEsocial(texto) {
  const t = String(texto || '');
  const avisos = [];
  if (!/<(\w+:)?eSocial[\s>]/.test(t)) return { tipo: 'esocial', eventos: [], competencias: [], avisos: ['O arquivo nao tem a raiz eSocial.'] };
  const eventos = [];
  for (const [tag, tipo, nome] of EVENTOS_ESO) {
    const re = new RegExp('<(?:\\w+:)?' + tag + '(?:\\s|>)', 'g');
    const n = (t.match(re) || []).length;
    if (n) eventos.push({ tipo, tag, nome, quantidade: n });
  }
  const comps = new Set();
  for (const m of t.matchAll(/<(\w+:)?perApur>\s*([0-9]{4}(?:-[0-9]{2})?)\s*<\/(\w+:)?perApur>/g)) {
    const v = m[2];
    comps.add(/^[0-9]{4}$/.test(v) ? v + '-12' : v);
  }
  if (!eventos.length) avisos.push('Nenhum evento de folha reconhecido (S-1000, S-1005, S-1010, S-1020, S-1200, S-2299).');
  if (!comps.size) avisos.push('Nenhuma competencia (perApur) informada nos eventos.');
  return { tipo: 'esocial', eventos, competencias: Array.from(comps).sort(), avisos };
}

module.exports = {
  digitos, cnpj, centavos, dataBr, competencia, sha256, normalizarChave,
  detectarFormato, parseCsvRetido, parseRelatorioPagamentos, parseEfdReinf, parseEcd, parseEsocial,
};
