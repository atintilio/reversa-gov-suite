/*
 * Reversa Tax — motor previdenciário: lê os XML do eSocial e estima as oportunidades das teses da folha.
 *
 * Eventos lidos (leiaute S-1.x):
 *   S-1000 (evtInfoEmpregador)  empregador
 *   S-1005 (evtTabEstab)        estabelecimentos: CNAE preponderante, alíquota RAT e FAP
 *   S-1010 (evtTabRubrica)      rubricas: descrição, natureza (natRubr), tipo (tpRubr) e incidência previdenciária (codIncCP)
 *   S-1020 (evtTabLotacao)      lotações: FPAS e código de terceiros (exibidos)
 *   S-1200 (evtRemun)           remuneração por trabalhador, competência e estabelecimento
 *   S-2299 (evtDeslig)          rescisão: verbas rescisórias (verbasResc/dmDev/infoPerApur/ideEstabLot/detVerbas) — leiaute a validar com XML real (Sodimac)
 *   S-3000 (evtExclusao)        exclusão de evento: descarta o evento lido cujo recibo case com nrRecEvt (quando o XML traz o recibo)
 * Arquivos de lote (envioLoteEventos), retornos com o evento embutido e retificadoras (indRetif = 2) são aceitos.
 *
 * Regra de cálculo (estimativa preliminar, não é crédito):
 *   - Só rubricas de vencimento (tpRubr 1) com incidência patronal declarada no S-1010:
 *     codIncCP 11 (mensal), 12 (13º), 21 e 22 (salário-maternidade pago pela empresa).
 *   - A rubrica é associada a uma tese pela descrição (palavras-chave), sempre listada para conferência humana.
 *   - Valor = base × (CPP 20% + RAT × FAP do estabelecimento + terceiros).
 *     Terceiros: 5,8% estimado (salário-educação 2,5% + INCRA 0,2% + Sistema S 2,5% + SEBRAE 0,6%), a confirmar pelo FPAS.
 *   - RAT reflexos (13º, DSR, dias não trabalhados): base × RAT × FAP, para decisão da empresa.
 *   - "No prazo": competências dos últimos 5 anos (CTN, art. 168, I).
 * v0.2.0:
 *   - Escopo: só Lucro Real/Presumido (S-1000 classTrib 99), avaliado POR COMPETÊNCIA pelo histórico de vigências (escopo.historico).
 *     Competência fora do escopo não é calculada (salvo opts.forcarEscopo). CPRB (indDesFolha = 1) retira os 20% de CPP.
 *   - Terceiros: 5,8% sobre a base, sem teto de 20 SM (STJ Tema 1079, 2024; Tema 1390, j. 11/02/2026, REsp 2187625/RJ).
 *     Exceção opcional opts.terceirosExcecao {ini, fim}: tese T008 (limite de 20 salários mínimos por trabalhador e competência).
 *   - Rescisões (S-2299): mesma classificação por rubrica + T073 (férias indenizadas e 1/3), T071 (multa art. 477 CLT), T072 (art. 479 CLT / Lei 7.238 art. 9º).
 *   - Teses condicionais (condicional/condicao), teste de habitualidade na T065 e sensibilidade da borda do prazo de 5 anos.
 * v0.3.0:
 *   - T074: INSS do SEGURADO descontado a maior/em duplicidade. Rubricas de desconto (tpRubr 2 com natRubr 9201, ou codIncCP 31 + descrição INSS/PREVID)
 *     somadas por trabalhador e competência; devido = tabela progressiva do ano sobre a base (tpRubr 1, codIncCP 11/21), limitada ao teto; excesso = retido - devido.
 *     Não é contribuição patronal: valor = excesso integral (restituição ao empregado + compensação). 13º (codIncCP 12/22 ou perApur anual) fica fora, com aviso.
 * v0.4.0 (teses previdenciárias B):
 *   - Rubricas: natRubr (Tabela 3 do eSocial) tem PRIORIDADE sobre a descrição; a descrição é o plano B. Mapa parcial (NAT_RUBR): CONFERIR com a Tabela 3 oficial.
 *   - T009 revisão do FAP: (FAP declarado no S-1005 − opts.fapPublicado) × RAT × base, por competência. Sem o FAP revisado: valor zero + aviso.
 *   - T010 revisão do RAT/GILRAT: RAT declarado × grau de risco do CNAE do estabelecimento (Anexo V do Decreto 3.048/99). Tabela parcial CNAE_RISCO (CONFERIR) ou opts.cnaeRisco.
 *   - T061 RAT por atividade preponderante (Súmula 351 STJ): estabelecimentos que repetem o RAT do estabelecimento preponderante (mais empregados) acima do grau do próprio CNAE.
 *   - T059 sanitização de rubricas: natRubr não salarial com incidência patronal declarada e sem tese específica; incoerências natRubr × codIncCP viram aviso.
 *   - T076 13º sobre aviso-prévio indenizado (S-2299): 1/12 do aviso, limitado ao 13º com incidência pago na rescisão (ou o 13º do aviso pago em rubrica própria).
 *   Todo o valor é estimativa (pagamento: 'nao-confirmado'). Tags/leiaute marcados "a validar com XML real (Sodimac)" são tolerantes a variações de nome.
 * Funciona no navegador (window.MotorEsocial) e no Node (module.exports).
 */
(function (root) {
  'use strict';
  var VERSAO = '0.5.0';
  var CPP = 0.20, TERCEIROS_PADRAO = 0.058;
  // a validar com XML real (Sodimac): nomes de tag aceitos (comparação sem diferenciar maiúsculas/minúsculas)
  var TAGS_CLASSTRIB = ['classTrib'], TAGS_DESFOLHA = ['indDesFolha', 'indDesoneracao', 'indCPRB'];
  var TAGS_ITENS = ['itensRemun', 'detVerbas'];            // S-1200 usa itensRemun; S-2299 usa detVerbas (verbasResc)
  var CLASSTRIB_ESCOPO = '99';                              // pessoa jurídica em geral (Lucro Real/Presumido)
  var CLASSTRIB_DESC = { '99': 'Pessoa jurídica em geral', '01': 'Simples Nacional', '02': 'Simples Nacional', '03': 'Simples Nacional' }; // só os códigos de que há certeza
  // Salário mínimo nacional por vigência (CONFERIR com decreto: 2019-2025 conforme tabelas públicas; 2026 = Decreto 12.797/2025)
  var SM_VIGENCIAS = [['2019-01', 998], ['2020-01', 1039], ['2020-02', 1045], ['2021-01', 1100], ['2022-01', 1212], ['2023-01', 1302], ['2023-05', 1320], ['2024-01', 1412], ['2025-01', 1518], ['2026-01', 1621]];
  var SALARIO_MINIMO = {};
  (function () { for (var a = 2019; a <= 2026; a++) for (var m = 1; m <= 12; m++) { var c = a + '-' + (m < 10 ? '0' : '') + m, v; SM_VIGENCIAS.forEach(function (x) { if (x[0] <= c) v = x[1]; }); SALARIO_MINIMO[c] = v; } })();
  // Tabela progressiva do INSS do segurado (contribuição empregado): [[limite da faixa, alíquota]...]; o último limite é o teto.
  // 2020-03 a 2022: portarias SEPRT 914/2020, ME 477/2021 e 12/2022 (2022 conferida com o cenário Grupo Mateus).
  // CONFERIR com a portaria: 2023 a 2026 (valores de memória; 2026 sem confirmação).
  var INSS_TABELAS = [
    { ini: '2020-03', fim: '2020-12', conferir: false, f: [[1045.00, 0.075], [2089.60, 0.09], [3134.40, 0.12], [6101.06, 0.14]] },
    { ini: '2021-01', fim: '2021-12', conferir: false, f: [[1100.00, 0.075], [2203.48, 0.09], [3305.22, 0.12], [6433.57, 0.14]] },
    { ini: '2022-01', fim: '2022-12', conferir: false, f: [[1212.00, 0.075], [2427.35, 0.09], [3641.03, 0.12], [7087.22, 0.14]] },
    { ini: '2023-01', fim: '2023-04', conferir: true, f: [[1302.00, 0.075], [2571.29, 0.09], [3856.94, 0.12], [7507.49, 0.14]] },
    { ini: '2023-05', fim: '2023-12', conferir: true, f: [[1320.00, 0.075], [2571.29, 0.09], [3856.94, 0.12], [7507.49, 0.14]] },
    { ini: '2024-01', fim: '2024-12', conferir: true, f: [[1412.00, 0.075], [2666.68, 0.09], [4000.03, 0.12], [7786.02, 0.14]] },
    { ini: '2025-01', fim: '2025-12', conferir: true, f: [[1518.00, 0.075], [2793.88, 0.09], [4190.83, 0.12], [8157.41, 0.14]] },
    { ini: '2026-01', fim: '2026-12', conferir: true, f: [[1621.00, 0.075], [2902.84, 0.09], [4354.27, 0.12], [8475.55, 0.14]] }
  ];
  function tabelaInss(comp) { for (var i = 0; i < INSS_TABELAS.length; i++) if (comp >= INSS_TABELAS[i].ini && comp <= INSS_TABELAS[i].fim) return INSS_TABELAS[i]; return null; }
  /** INSS devido: soma exata das faixas sobre a base limitada ao teto, arredondada ao centavo no final. */
  function contribInss(base, tab) {
    var teto = tab.f[tab.f.length - 1][0], restante = Math.min(base, teto), ant = 0, v = 0;
    tab.f.forEach(function (x) { var parte = Math.max(0, Math.min(restante, x[0]) - ant); v += parte * x[1]; ant = x[0]; });
    return Math.round(v * 100 + 1e-7) / 100;
  }
  function ehInssSegurado(r) { return r.tpRubr === '2' && (r.natRubr === '9201' || (r.codIncCP === '31' && /INSS|PREVID/.test(norm(r.dsc)))); }
  var CONDICOES = {
    T063: 'Depende de acordo de PLR firmado conforme a Lei 10.101/2000.',
    T065: 'Apenas gratificações e prêmios eventuais (habituais ficam de fora).',
    T066: 'Forma de pagamento: PAT, cartão ou in natura, não em dinheiro.',
    T068: 'Plano disponível a todos os empregados.',
    T008: 'Depende de ação judicial/decisão favorável e da modulação (Tema 1079); informar período.',
    T009: 'Depende do FAP revisado (contestação/revisão administrativa ou ação): extrato do FAP na Dataprev/Previdência, relação de CAT e benefícios acidentários e vínculos/rotatividade.',
    T010: 'Depende do enquadramento correto do CNAE (Anexo V do Decreto 3.048/99) por estabelecimento; conferir a tabela de grau de risco e o enquadramento contratado.',
    T061: 'Depende do número de empregados por estabelecimento/lotação e do CNAE de cada CNPJ (Súmula 351 do STJ); conferir o enquadramento.',
    T059: 'Revisão rubrica a rubrica: confirmar a natureza indenizatória e a habitualidade antes de pleitear; se houver tese específica para a verba, usar a específica.',
    T076: 'Depende do entendimento sobre a incidência no 13º proporcional ao aviso-prévio indenizado (a RFB entende que incide; a tese é controvertida). Marcar só se a empresa decidir pleitear.'
  };
  // Mapa PARCIAL da Tabela 3 do eSocial (natRubr) — CONFERIR com a Tabela 3 oficial antes de usar o resultado.
  // tese: tese da rubrica (prioridade sobre a descrição); cat: 'salarial' (integra o salário de contribuição), 'naoSalarial' (verba indenizatória/assistencial/eventual) ou 'desconto'.
  var NAT_RUBR = {
    '1000': { cat: 'salarial', nome: 'Salário, vencimento, soldo ou subsídio' }, '1003': { cat: 'salarial', nome: 'Horas extraordinárias' },
    '1202': { cat: 'salarial', nome: 'Adicional de insalubridade' }, '1203': { cat: 'salarial', nome: 'Adicional de periculosidade' },
    '1205': { cat: 'salarial', nome: 'Adicional noturno' }, '1206': { cat: 'salarial', nome: 'Adicional por tempo de serviço' },
    '1214': { cat: 'salarial', nome: 'Adicional de penosidade' }, '1299': { cat: 'salarial', nome: 'Outros adicionais' }, '1212': { cat: 'salarial', nome: 'Gratificações de natureza permanente' },
    '1604': { cat: 'salarial', nome: 'Ajuda de custo acima de 50% da remuneração' }, '1652': { cat: 'salarial', nome: 'Diárias acima de 50% do salário' },
    '1211': { cat: 'eventual', tese: 'T065', nome: 'Gratificações' }, '1213': { cat: 'eventual', tese: 'T065', nome: 'Gratificações de natureza transitória' }, '2501': { cat: 'eventual', tese: 'T065', nome: 'Prêmios' },
    '1300': { cat: 'naoSalarial', tese: 'T063', nome: 'PLR' }, '1810': { cat: 'naoSalarial', tese: 'T067', nome: 'Transporte' }, '1801': { cat: 'naoSalarial', tese: 'T066', nome: 'Alimentação' },
    '1405': { cat: 'naoSalarial', tese: 'T068', nome: 'Assistência médica' },
    '6003': { cat: 'naoSalarial', nome: 'Indenização compensatória do aviso-prévio' }, '6001': { cat: 'naoSalarial', nome: 'Aviso-prévio indenizado / 13º do aviso (código a conferir)' }, // 6001/6003: sem tese fixa (a fonte consultada diverge; a descrição decide)
    '6006': { cat: 'naoSalarial', tese: 'T073', nome: 'Férias proporcionais' }, '6007': { cat: 'naoSalarial', tese: 'T073', nome: 'Férias vencidas na rescisão' }, '6004': { cat: 'naoSalarial', tese: 'T073', nome: 'Férias em dobro na rescisão' },
    '6106': { cat: 'naoSalarial', tese: 'T071', nome: 'Multa do art. 477 da CLT' }, '6104': { cat: 'naoSalarial', tese: 'T072', nome: 'Indenização do art. 479 da CLT' }, '6904': { cat: 'naoSalarial', nome: 'Multa do art. 480 da CLT' },
    '1602': { cat: 'naoSalarial', nome: 'Ajuda de custo de transferência' }, '1603': { cat: 'naoSalarial', nome: 'Ajuda de custo' },
    '1650': { cat: 'naoSalarial', nome: 'Diárias de viagem' }, '1651': { cat: 'naoSalarial', nome: 'Diárias de viagem até 50% do salário' },
    '1406': { cat: 'naoSalarial', nome: 'Auxílio-creche' }, '1407': { cat: 'naoSalarial', nome: 'Auxílio-educação' },
    '1350': { cat: 'naoSalarial', nome: 'Bolsa de estudo (estagiário)' }, '1351': { cat: 'naoSalarial', nome: 'Bolsa de estudo (médico residente)' }, '1352': { cat: 'naoSalarial', nome: 'Bolsa de estudo ou pesquisa' },
    '1409': { cat: 'naoSalarial', nome: 'Salário-família' },
    '9201': { cat: 'desconto', nome: 'Contribuição previdenciária (INSS)' }, '9216': { cat: 'desconto', nome: 'Desconto de vale-transporte' }, '9219': { cat: 'desconto', nome: 'Desconto de assistência médica ou odontológica' },
    '9220': { cat: 'desconto', nome: 'Desconto de alimentação' }, '9223': { cat: 'desconto', nome: 'Previdência complementar (empregado)' }, '9250': { cat: 'desconto', nome: 'Seguro de vida (desconto)' }
  };
  // Grau de risco (RAT: 1 = 1%, 2 = 2%, 3 = 3%) por CNAE-Subclasse — Anexo V do Decreto 3.048/99. TABELA PARCIAL (amostra): CONFERIR com o Anexo V; use opts.cnaeRisco para completar/corrigir.
  var CNAE_RISCO = {
    '6201501': 1, '6911701': 1, '7020400': 1, '8211300': 1, '4711301': 2, '4711302': 2, '4120400': 3, '1011201': 3, '4930202': 3
  };
  // Documentos além da procuração/XML do eSocial, por tese
  var DOCUMENTOS = {
    T009: ['Extrato do FAP na Dataprev/Previdência (FAP vigente e FAP revisado/contestado)', 'Relação de CAT emitidas e de benefícios acidentários (B91/B92/B93/B94)', 'Vínculos e rotatividade (RAIS/CAGED ou eSocial) do período do FAP'],
    T010: ['Enquadramento do CNAE por estabelecimento (cartão CNPJ e S-1005)', 'Descrição da atividade econômica real de cada estabelecimento (para sustentar o grau de risco)'],
    T061: ['Número de empregados por estabelecimento e por lotação (S-1200, já lido)', 'CNAE e atividade de cada CNPJ (cartão CNPJ)'],
    T059: ['Tabela 3 oficial do eSocial (natureza das rubricas)', 'Acordos/convenções e políticas internas que definam a natureza e a habitualidade de cada verba'],
    T076: ['Termos de rescisão (TRCT) e S-2299 com as verbas rescisórias', 'Decisão da empresa sobre pleitear a tese (incidência controvertida)']
  };
  var INCIDE_PATRONAL = { '11': 'mensal', '12': '13º salário', '21': 'salário-maternidade (empresa)', '22': 'salário-maternidade 13º (empresa)' };

  // ------------------------------------------------------------------ XML mínimo (sem dependências)
  function parseXml(texto) {
    var s = String(texto || '').replace(/^﻿/, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, function (m, c) { return c.replace(/</g, '&lt;'); });
    var raiz = { nome: '#doc', filhos: [], texto: '' }, pilha = [raiz];
    var re = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g, m;
    while ((m = re.exec(s))) {
      var topo = pilha[pilha.length - 1];
      if (m[5] !== undefined) { topo.texto += m[5]; continue; }
      var nome = m[2].split(':').pop();
      if (m[1]) { if (pilha.length > 1) pilha.pop(); continue; }
      var no = { nome: nome, filhos: [], texto: '', attrs: {} };
      Object.defineProperty(no, 'pai', { value: topo, enumerable: false }); // para achar o recibo do evento no retorno
      String(m[3] || '').replace(/([\w:.-]+)\s*=\s*"([^"]*)"/g, function (x, k, v) { no.attrs[k.split(':').pop()] = v; return x; });
      topo.filhos.push(no);
      if (!m[4] && !/\/\s*$/.test(m[3] || '')) pilha.push(no);
    }
    return raiz;
  }
  function decod(t) { return String(t || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim(); }
  function filho(no, nome) { if (!no) return null; for (var i = 0; i < no.filhos.length; i++) if (no.filhos[i].nome === nome) return no.filhos[i]; return null; }
  function filhos(no, nome) { return no ? no.filhos.filter(function (f) { return f.nome === nome; }) : []; }
  function txt(no, caminho) { var n = no; caminho.split('/').forEach(function (p) { n = filho(n, p); }); return n ? decod(n.texto) : ''; }
  function todos(no, nome, acc) { acc = acc || []; if (!no) return acc; no.filhos.forEach(function (f) { if (f.nome === nome) acc.push(f); todos(f, nome, acc); }); return acc; }
  function num(v) { var n = Number(String(v || '').replace(',', '.')); return isFinite(n) ? n : 0; }
  function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim(); }

  function acharTxt(no, nomes) { // primeiro texto não vazio de uma tag (em qualquer nível), sem diferenciar maiúsculas
    var set = nomes.map(function (x) { return x.toLowerCase(); }), res = '';
    (function walk(n) { if (!n) return; n.filhos.forEach(function (f) { if (!res && set.indexOf(f.nome.toLowerCase()) >= 0 && decod(f.texto)) res = decod(f.texto); walk(f); }); })(no);
    return res;
  }
  function mesAnterior(c) { var a = +c.slice(0, 4), m = +c.slice(5, 7) - 1; if (m < 1) { m = 12; a--; } return a + '-' + (m < 10 ? '0' : '') + m; }
  function brl(v) { return 'R$ ' + (Math.round(v * 100) / 100).toFixed(2).replace('.', ','); }
  function reciboDe(no) { // nrRecibo do retorno que embrulha o evento (download/retorno de lote), se houver
    for (var a = no && no.pai; a; a = a.pai) { var r = filho(a, 'recibo'); if (r && txt(r, 'nrRecibo')) return txt(r, 'nrRecibo'); }
    return '';
  }

  var EVENTOS = { evtInfoEmpregador: 'S-1000', evtTabEstab: 'S-1005', evtTabRubrica: 'S-1010', evtTabLotacao: 'S-1020', evtRemun: 'S-1200', evtFechaEvPer: 'S-1299', evtDeslig: 'S-2299', evtExclusao: 'S-3000' };

  /** Lê um arquivo XML e devolve os eventos reconhecidos. */
  function lerXml(texto, nomeArquivo) {
    var r = { arquivo: nomeArquivo || 'arquivo.xml', eventos: [], erros: [], avisos: [] };
    if (!/<([\w]+:)?eSocial[\s>]/.test(String(texto || ''))) { r.erros.push('Não é um XML do eSocial.'); return r; }
    var doc;
    try { doc = parseXml(texto); } catch (e) { r.erros.push('XML inválido.'); return r; }
    Object.keys(EVENTOS).forEach(function (tag) {
      todos(doc, tag).forEach(function (ev) { r.eventos.push({ tipo: EVENTOS[tag], no: ev, id: (ev.attrs && ev.attrs.Id) || '' }); });
    });
    if (!r.eventos.length) r.avisos.push('Nenhum evento usado no cálculo (S-1000, S-1005, S-1010, S-1020, S-1200, S-2299) neste arquivo.');
    return r;
  }

  // ------------------------------------------------------------------ teses e palavras-chave das rubricas
  // Ordem importa: a primeira regra que casar define a tese da rubrica.
  var REGRAS = [
    { id: 'T004', re: /MATERNIDADE/, motivo: 'salário-maternidade' },
    { id: 'T064', re: /PATERNIDADE/, motivo: 'licença-paternidade' },
    { id: 'T076', re: /(13|DECIMO TERCEIRO).*(AVISO|AV\.? ?PREV)|(AVISO|AV\.? ?PREV).*(13 ?(O|º)? ?SAL|DECIMO TERCEIRO)/, motivo: '13º salário relativo ao aviso-prévio indenizado' },
    { id: 'T005', re: /AVISO ?PREVIO INDENIZ|AV\.? ?PREV(IO)?\.? ?INDENIZ|AVISO INDENIZ/, motivo: 'aviso-prévio indenizado' },
    { id: 'T073', re: /FERIAS.*INDENIZ|INDENIZ.*FERIAS/, motivo: 'férias indenizadas e respectivo 1/3' },
    { id: 'T073', soResc: true, re: /FERIAS (PROPORC|VENCID)|(1\/3|TERCO).*FERIAS|FERIAS.*(1\/3|TERCO)/, motivo: 'férias (proporcionais/vencidas) e 1/3 na rescisão' },
    { id: 'T071', re: /^(?!.*FGTS).*(ART\.? ?477|MULTA (DO |DA )?(RESCISOR|RESCISAO))/, motivo: 'multa do art. 477 da CLT' },
    { id: 'T072', re: /ART\.? ?479|ART\.? ?9\b.*7\.?238|LEI 7\.?238|ADICIONAL INDENIZATORIO|INDENIZ.*(DISPENSA|SEM JUSTA CAUSA)/, motivo: 'indenização por dispensa (art. 479 CLT / Lei 7.238 art. 9º)' },
    { id: 'T006', re: /15 (PRIMEIROS )?DIAS|PRIMEIROS 15|AUX(ILIO)?\.? ?DOENCA|AUX(ILIO)?\.? ?ENFERMIDADE|AFAST(AMENTO)?\.? ?(POR )?DOENCA/, motivo: '15 primeiros dias de afastamento' },
    { id: 'T063', re: /\bPLR\b|PARTICIPACAO (NOS |NO )?(LUCROS|RESULTADOS)|\bPPR\b/, motivo: 'participação nos lucros ou resultados' },
    { id: 'T067', re: /VALE[ -]?TRANSPORTE|AUX(ILIO)?\.? ?TRANSPORTE|\bV\.?T\.?\b/, motivo: 'vale-transporte' },
    { id: 'T066', re: /ALIMENTACAO|REFEICAO|TICKET|CESTA BASICA/, motivo: 'auxílio-alimentação' },
    { id: 'T068', re: /PLANO (DE )?SAUDE|ASSIST(ENCIA)?\.? ?(MEDICA|ODONTO)|ODONTOLOG|CONVENIO (MEDICO|ODONTO)|REEMBOLSO (MEDICO|DE MEDICAMENTOS?)|MEDICAMENTO/, motivo: 'assistência médica e odontológica' },
    { id: 'T062', re: /DOBRA|EM DOBRO|DOMINGOS? (E FERIADOS? )?TRAB|FERIADOS? TRAB/, motivo: 'domingos e feriados em dobro' },
    { id: 'T007', re: /^(?!.*INDENIZ).*(1\/3|TERCO (CONST(ITUCIONAL)? )?(DE )?FERIAS|ADICIONAL (CONST(ITUCIONAL)? )?(DE )?FERIAS)/, motivo: 'terço constitucional de férias' },
    { id: 'T065', re: /^(?!.*FERIAS).*(GRATIFICA|PREMIO|PREMIACAO|BONUS|BONIFICA|ABONO)/, motivo: 'gratificação, prêmio ou abono' },
    { id: 'T028', re: /INDENIZ|AJUDA DE CUSTO|DIARIAS? DE VIAGEM/, motivo: 'verba de natureza indenizatória' }
  ];
  // Reflexos para RAT (13º, DSR, dias não trabalhados): base própria, só a alíquota RAT × FAP.
  var REFLEXOS = /\bDSR\b|REPOUSO|DESCANSO SEMANAL|13 ?(O|º)? ?SAL|DECIMO TERCEIRO|FALTAS? (JUSTIFICADAS|ABONADAS)|DIAS NAO TRABALHADOS/;
  var NOMES = {
    T004: 'Contribuição previdenciária sobre salário-maternidade', T005: 'Contribuição previdenciária sobre aviso-prévio indenizado',
    T006: 'Contribuição previdenciária sobre primeiros 15 dias de afastamento', T007: 'Terço constitucional de férias',
    T028: 'INSS sobre verbas de natureza indenizatória', T062: 'Contribuição previdenciária sobre hora dobrada (domingos e feriados trabalhados)',
    T063: 'Contribuição previdenciária sobre PLR paga conforme a Lei 10.101/2000', T064: 'Contribuição previdenciária sobre licença-paternidade',
    T065: 'Contribuição previdenciária sobre gratificações e prêmios eventuais', T066: 'Contribuição previdenciária sobre auxílio-alimentação (tíquete, cartão ou in natura)',
    T067: 'Contribuição previdenciária sobre vale-transporte', T068: 'Contribuição previdenciária sobre assistência médica e odontológica',
    T069: 'RAT/GILRAT — reflexos sobre 13º salário, DSR e dias não trabalhados',
    T008: 'Contribuições a terceiros: limite de 20 salários mínimos (empresa com ação ou decisão favorável)',
    T073: 'Contribuição previdenciária sobre férias indenizadas e terço constitucional de férias indenizadas',
    T071: 'Contribuição previdenciária sobre multa do art. 477 da CLT (multa rescisória)',
    T072: 'Contribuição previdenciária sobre indenização por dispensa (art. 479 da CLT / Lei 7.238/84, art. 9º)',
    T074: 'INSS do segurado descontado a maior ou em duplicidade (restituição ao empregado e compensação)',
    T009: 'Revisão do FAP (Fator Acidentário de Prevenção): diferença entre o FAP aplicado e o FAP revisado sobre a base do RAT',
    T010: 'Revisão do RAT/GILRAT: alíquota declarada acima do grau de risco do CNAE do estabelecimento (Decreto 3.048/99, Anexo V)',
    T061: 'RAT por atividade preponderante (Súmula 351 do STJ): estabelecimento com RAT do estabelecimento preponderante acima do grau do próprio CNAE',
    T059: 'Sanitização de rubricas e incidências: verbas de natureza não salarial (Tabela 3) com incidência previdenciária declarada',
    T076: 'Contribuição previdenciária sobre 13º salário relativo ao aviso-prévio indenizado'
  };
  function classificar(dsc, resc) {
    var d = norm(dsc);
    for (var i = 0; i < REGRAS.length; i++) if ((!REGRAS[i].soResc || resc) && REGRAS[i].re.test(d)) return REGRAS[i];
    return null;
  }
  /** Rubrica -> tese: natRubr (Tabela 3, mapa parcial) tem prioridade; a descrição é o plano B. */
  function classificarRub(r, resc, mapa) {
    var n = (mapa || NAT_RUBR)[r.natRubr];
    if (n && n.tese) {
      var regra = null; REGRAS.forEach(function (x) { if (!regra && x.id === n.tese) regra = x; });
      return { id: n.tese, motivo: (regra ? regra.motivo : NOMES[n.tese]) + ' (natRubr ' + r.natRubr + ')', origem: 'natRubr' };
    }
    return classificar(r.dsc, resc);
  }
  function digitos(s) { return String(s || '').replace(/\D/g, ''); }
  /** Grau de risco (1-3) do CNAE: opts.cnaeRisco {cnae: grau} (7, 5 ou 4 dígitos) > tabela parcial. */
  function grauCnae(cnae, ov) {
    var d = digitos(cnae), o = ov || {}, t = {}, k;
    Object.keys(o).forEach(function (x) { t[digitos(x)] = +o[x]; });
    for (k = d.length; k >= 4; k--) if (t[d.slice(0, k)] >= 1) return { grau: t[d.slice(0, k)], fonte: 'informado' };
    if (CNAE_RISCO[d] >= 1) return { grau: CNAE_RISCO[d], fonte: 'tabela-parcial' };
    return null;
  }
  /** FAP revisado da competência: número, lista [{ini,fim,fap}] ou objeto {cnpj: número|lista}. */
  function fapDe(f, nr, comp) {
    if (f == null) return null;
    if (typeof f === 'object' && !Array.isArray(f)) { if (f[nr] == null) return null; f = f[nr]; }
    if (typeof f === 'number') return f;
    if (!Array.isArray(f)) return null;
    var v = null; f.forEach(function (x) { if ((!x.ini || x.ini <= comp) && (!x.fim || x.fim >= comp) && x.fap != null) v = +x.fap; });
    return v;
  }

  // ------------------------------------------------------------------ apuração
  function vigente(lista, comp) {
    // registro de tabela vigente na competência (iniValid/fimValid em AAAA-MM)
    var ok = lista.filter(function (x) { return (!x.ini || x.ini <= comp) && (!x.fim || x.fim >= comp); });
    return (ok.length ? ok : lista)[ok.length ? ok.length - 1 : lista.length - 1] || null;
  }
  function cincoAnos(hoje) { var d = new Date(hoje || Date.now()); return (d.getFullYear() - 5) + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

  /**
   * Competencia de apuracao: o 13o (apuracao anual, indApuracao=2) e competencia
   * PROPRIA, nao o mesmo lancamento de dezembro. A folha de 5 anos tem 60
   * competencias nominais + 5 de 13o = 65.
   */
  function compDeApuracao(per, ind) {
    if (/^\d{4}$/.test(String(per))) return per + '-12/13';
    return per;
  }

  /** O mes puro da competencia: regime, vigencia de tabela, salario minimo e FAP sao por MES. */
  function compMes(comp) { return String(comp).slice(0, 7); }

  function salarioMinimo(comp) { return SALARIO_MINIMO[comp]; }

  /** Histórico de regime do S-1000: [{ini, fim, classTrib, descricao, cprb}] ordenado; fim derivado da próxima vigência. */
  function montaHistorico(regs) {
    var porIni = {};
    regs.forEach(function (r) { porIni[r.ini || ''] = r; }); // mesma vigência: a última lida vale
    var l = Object.keys(porIni).sort().map(function (k) { return porIni[k]; });
    return l.map(function (r, i) {
      var fim = r.fim || (l[i + 1] && l[i + 1].ini ? mesAnterior(l[i + 1].ini) : null);
      return { ini: r.ini || null, fim: fim, classTrib: r.classTrib, descricao: CLASSTRIB_DESC[r.classTrib] || (r.classTrib ? 'classTrib ' + r.classTrib : 'classTrib não informado'), cprb: r.cprb };
    });
  }
  function regimeEm(hist, comp) { // vigência mais recente com ini <= comp (fim explícito já vencido => sem regime); null se não identificado
    var ok = null;
    hist.forEach(function (h) { if (!h.ini || h.ini <= comp) ok = h; });
    if (ok && ok.fim && ok.fim < comp) ok = null;
    return ok && ok.classTrib ? ok : null;
  }

  /**
   * @param {Array} lidos  resultados de lerXml
   * @param {{hoje?: Date, terceiros?: number, terceirosExcecao?: {ini:string, fim:string}|null, forcarEscopo?: boolean}} opts
   */
  function apurarBase(lidos, opts) {
    opts = opts || {};
    var terceiros = opts.terceiros == null ? TERCEIROS_PADRAO : Number(opts.terceiros);
    var limite = cincoAnos(opts.hoje);
    var exc = opts.terceirosExcecao && opts.terceirosExcecao.ini && opts.terceirosExcecao.fim ? opts.terceirosExcecao : null;
    var forcar = opts.forcarEscopo === true;
    var rubricas = {}, estabs = {}, lotacoes = {}, empregador = { cnpjRaiz: '', nome: '' }, regs = [];
    var cands = [], exclusoes = [], contagem = { 'S-1000': 0, 'S-1005': 0, 'S-1010': 0, 'S-1020': 0, 'S-1200': 0, 'S-2299': 0, 'S-3000': 0 }, avisos = [];
    lidos.forEach(function (l) {
      l.eventos.forEach(function (ev) {
        contagem[ev.tipo] = (contagem[ev.tipo] || 0) + 1;
        var n = ev.no, ide = filho(n, 'ideEmpregador');
        if (ide && !empregador.cnpjRaiz) empregador.cnpjRaiz = txt(ide, 'nrInsc');
        if (ev.tipo === 'S-1000') {
          var info = todos(n, 'infoCadastro')[0]; if (info) empregador.nome = empregador.nome || txt(info, 'nmRazao');
          // vigências: inclusao/alteracao com idePeriodo(iniValid, fimValid) e infoCadastro(classTrib, indDesFolha) — a validar com XML real (Sodimac)
          var ops = []; ['inclusao', 'alteracao'].forEach(function (op) { todos(n, op).forEach(function (o) { ops.push(o); }); });
          if (!ops.length && info) ops.push(n);
          ops.forEach(function (o) {
            var ic = todos(o, 'infoCadastro')[0] || o, ct = acharTxt(ic, TAGS_CLASSTRIB); if (!ct) return;
            var idp = todos(o, 'idePeriodo')[0];
            regs.push({ ini: idp ? txt(idp, 'iniValid') : '', fim: idp ? txt(idp, 'fimValid') : '', classTrib: ct, cprb: acharTxt(ic, TAGS_DESFOLHA) === '1' });
          });
        } else if (ev.tipo === 'S-1010') {
          ['inclusao', 'alteracao'].forEach(function (op) {
            todos(n, op).forEach(function (o) {
              var ir = filho(o, 'ideRubrica'), dr = filho(o, 'dadosRubrica'); if (!ir || !dr) return;
              var k = txt(ir, 'ideTabRubr') + '|' + txt(ir, 'codRubr');
              (rubricas[k] = rubricas[k] || []).push({ ini: txt(ir, 'iniValid'), fim: txt(ir, 'fimValid'), cod: txt(ir, 'codRubr'), tab: txt(ir, 'ideTabRubr'),
                dsc: txt(dr, 'dscRubr'), natRubr: txt(dr, 'natRubr'), tpRubr: txt(dr, 'tpRubr'), codIncCP: txt(dr, 'codIncCP') });
            });
          });
        } else if (ev.tipo === 'S-1005') {
          ['inclusao', 'alteracao'].forEach(function (op) {
            todos(n, op).forEach(function (o) {
              var ie = filho(o, 'ideEstab'), de = filho(o, 'dadosEstab'); if (!ie || !de) return;
              var g = filho(de, 'aliqGilrat');
              (estabs[txt(ie, 'nrInsc')] = estabs[txt(ie, 'nrInsc')] || []).push({ ini: txt(ie, 'iniValid'), fim: txt(ie, 'fimValid'),
                cnae: txt(de, 'cnaePrep'), rat: num(txt(g, 'aliqRat')), fap: num(txt(g, 'fap')) || 1 });
            });
          });
        } else if (ev.tipo === 'S-1020') {
          ['inclusao', 'alteracao'].forEach(function (op) {
            todos(n, op).forEach(function (o) {
              var il = filho(o, 'ideLotacao'), dl = filho(o, 'dadosLotacao'); if (!il || !dl) return;
              (lotacoes[txt(il, 'codLotacao')] = lotacoes[txt(il, 'codLotacao')] || []).push({ ini: txt(il, 'iniValid'), fim: txt(il, 'fimValid'),
                fpas: txt(dl, 'fpasLotacao/fpas'), codTercs: txt(dl, 'fpasLotacao/codTercs') });
            });
          });
        } else if (ev.tipo === 'S-1200') {
          var ie2 = filho(n, 'ideEvento'), it = filho(n, 'ideTrabalhador');
          var per = txt(ie2, 'perApur'), ind = txt(ie2, 'indApuracao') || '1';
          var comp = compDeApuracao(per, ind);
          cands.push({ tipo: 'S-1200', chave: txt(it, 'cpfTrab') + '|' + per + '|' + ind, cpf: txt(it, 'cpfTrab'), comp: comp, anual: /^\d{4}$/.test(per), retif: txt(ie2, 'indRetif') === '2', no: n, arquivo: l.arquivo, recibo: reciboDe(n) });
        } else if (ev.tipo === 'S-2299') {
          // leiaute a validar com XML real (Sodimac): cpf em ideVinculo; competência = perApur se existir, senão mês de dtDeslig
          var cpfR = acharTxt(n, ['cpfTrab']), dt = acharTxt(n, ['dtDeslig']), pr = acharTxt(filho(n, 'ideEvento'), ['perApur']);
          var compR = /^\d{4}$/.test(pr) ? pr + '-12' : (pr || dt.slice(0, 7));
          cands.push({ tipo: 'S-2299', chave: cpfR + '|' + compR + '|resc', cpf: cpfR, comp: compR, retif: txt(filho(n, 'ideEvento'), 'indRetif') === '2', no: n, arquivo: l.arquivo, recibo: reciboDe(n) });
        } else if (ev.tipo === 'S-3000') {
          exclusoes.push({ nrRecEvt: acharTxt(n, ['nrRecEvt']), tpEvento: acharTxt(n, ['tpEvento']) });
        }
      });
    });

    // S-3000: descarta o evento lido cujo recibo case com nrRecEvt (só quando o XML traz o recibo)
    var pareadas = 0;
    exclusoes.forEach(function (x) {
      var achou = false;
      if (x.nrRecEvt) cands = cands.filter(function (c) { if (c.recibo && c.recibo === x.nrRecEvt) { achou = true; return false; } return true; });
      if (achou) pareadas++;
    });
    if (exclusoes.length - pareadas > 0) avisos.push(exclusoes.length - pareadas + ' evento(s) S-3000 (exclusão) sem evento pareado nos arquivos lidos (recibo não localizado): conferir se algum S-1200/S-2299 lido foi excluído.');
    // retificadora substitui a original da mesma pessoa, competência e tipo de apuração
    var remun = {};
    cands.forEach(function (c) { if (!remun[c.chave] || c.retif || !remun[c.chave].retif) remun[c.chave] = c; });

    // regime por competência (S-1000)
    var historico = montaHistorico(regs);
    var regimeNaoIdent = false, excluidas = {}, cprbComps = {}, classExcl = {};
    function regime(comp) {
      var h = regimeEm(historico, compMes(comp));
      if (!h) { regimeNaoIdent = true; return { ok: true, cprb: false, classTrib: '' }; }
      return { ok: h.classTrib === CLASSTRIB_ESCOPO, cprb: h.cprb, classTrib: h.classTrib };
    }

    var porTese = {}, semCadastro = {}, semIncidencia = {}, semTese = {}, rubricasUsadas = {}, comps = {}, reflexos = { base: 0, baseNoPrazo: 0, valor: 0, valorNoPrazo: 0, rubricas: {}, porComp: {} };
    var pend065 = [], baseTrab = {}, semSM = {};
    var inssRet = {}, inssBase = {}, inssDecimo = {};
    var mapaNat = Object.assign({}, NAT_RUBR, opts.natRubrMapa || {}), natUsada = false, incoerencias = {};
    var ratInfo = {}, headEst = {}, headLot = {}, n76est = 0, n76sem = 0;
    function acumula(tese, r, base, aliq, comp, motivo) {
      if (opts._excluir && opts._excluir[tese + '|' + r.tab + '|' + r.cod]) return; // rubrica reclassificada para tese do módulo extra (evita contar duas vezes)
      var t = porTese[tese] = porTese[tese] || { id: tese, nome: NOMES[tese], base: 0, baseNoPrazo: 0, valor: 0, valorNoPrazo: 0, rubricas: {}, competencias: {}, porComp: {} };
      var noPrazo = comp >= limite;
      t.base += base; t.valor += base * aliq; t.competencias[comp] = 1; t.porComp[comp] = (t.porComp[comp] || 0) + base * aliq;
      if (noPrazo) { t.baseNoPrazo += base; t.valorNoPrazo += base * aliq; }
      var k = r.tab + '|' + r.cod, x = t.rubricas[k] = t.rubricas[k] || { cod: r.cod, tab: r.tab, dsc: r.dsc, natRubr: r.natRubr, codIncCP: r.codIncCP, motivo: motivo, base: 0 };
      x.base += base;
    }
    function compDoEl(el, padrao) { // períodos anteriores do S-2299 (infoPerAnt): competência = perRef (a validar com XML real)
      for (var a = el.pai, i = 0; a && i < 6; a = a.pai, i++) { var p = filho(a, 'perRef'); if (p && /^\d{4}-\d{2}/.test(txt(a, 'perRef'))) return txt(a, 'perRef').slice(0, 7); }
      return padrao;
    }
    Object.keys(remun).forEach(function (k) {
      var e = remun[k]; comps[e.comp] = 1;
      todos(e.no, 'ideEstabLot').forEach(function (el) {
        var comp = e.tipo === 'S-2299' ? compDoEl(el, e.comp) : e.comp; comps[comp] = 1;
        var reg = regime(comp);
        if (!reg.ok) { excluidas[comp] = 1; classExcl[reg.classTrib] = 1; if (!forcar) return; }
        if (reg.cprb) cprbComps[comp] = 1;
        var nrInsc = txt(el, 'nrInsc'), est = estabs[nrInsc] ? vigente(estabs[nrInsc], compMes(comp)) : null;
        var ratAj = est ? est.rat / 100 * est.fap : null;
        if (e.tipo === 'S-1200') { // empregados por estabelecimento e por lotação (T061)
          (headEst[nrInsc] = headEst[nrInsc] || {})[e.cpf + '|' + compMes(comp)] = 1;
          var kl = nrInsc + '|' + txt(el, 'codLotacao'); (headLot[kl] = headLot[kl] || {})[e.cpf + '|' + compMes(comp)] = 1;
        }
        var av = { aviso: 0, real: 0, d13: 0 };
        var itens = []; TAGS_ITENS.forEach(function (tg) { todos(el, tg).forEach(function (x) { itens.push(x); }); });
        itens.forEach(function (ir) {
          var cod = txt(ir, 'codRubr'), tab = txt(ir, 'ideTabRubr'), vr = num(txt(ir, 'vrRubr'));
          var lista = rubricas[tab + '|' + cod];
          if (!lista) { semCadastro[tab + '|' + cod] = (semCadastro[tab + '|' + cod] || 0) + vr; return; }
          var r = vigente(lista, compMes(comp));
          rubricasUsadas[tab + '|' + cod] = r;
          var rc = classificarRub(r, e.tipo === 'S-2299', mapaNat); // natRubr tem prioridade sobre a descrição
          if (rc && rc.origem === 'natRubr') natUsada = true;
          if (e.tipo === 'S-2299' && r.tpRubr === '1' && vr > 0) { // insumos da T076
            if (rc && rc.id === 'T005') av.aviso += vr;
            else if (rc && rc.id === 'T076') { if (INCIDE_PATRONAL[r.codIncCP]) av.real += vr; }
            else if (/13 ?(O|º)? ?SAL|DECIMO TERCEIRO/.test(norm(r.dsc)) && INCIDE_PATRONAL[r.codIncCP]) av.d13 += vr;
          }
          var kI = e.cpf + '|' + comp;
          if (ehInssSegurado(r)) { if (vr > 0) { inssRet[kI] = (inssRet[kI] || 0) + vr; if (e.anual) inssDecimo[kI] = 1; } return; } // INSS do segurado: analisado na T074, não é patronal
          if (r.tpRubr === '1' && vr > 0) {
            if (e.anual || r.codIncCP === '12' || r.codIncCP === '22') inssDecimo[kI] = 1;
            else if (r.codIncCP === '11' || r.codIncCP === '21') inssBase[kI] = (inssBase[kI] || 0) + vr;
          }
          if (r.tpRubr !== '1' || !INCIDE_PATRONAL[r.codIncCP] || vr <= 0) {
            var nmI = mapaNat[r.natRubr];
            if (r.tpRubr === '1' && vr > 0 && nmI && nmI.cat === 'salarial' && !INCIDE_PATRONAL[r.codIncCP]) incoerencias[r.dsc + ' (natRubr ' + r.natRubr + ', incidência ' + (r.codIncCP || 'não informada') + ')'] = 1;
            if (vr > 0) { var kn = r.dsc + ' (tipo ' + (r.tpRubr || '?') + ', incidência ' + (r.codIncCP || 'não informada') + ')'; semIncidencia[kn] = (semIncidencia[kn] || 0) + vr; }
            return;
          }
          if (exc && compMes(comp) >= exc.ini && compMes(comp) <= exc.fim) baseTrab[e.cpf + '|' + comp] = (baseTrab[e.cpf + '|' + comp] || 0) + vr; // base do trabalhador (todos os estabelecimentos)
          var c = rc;
          var aliq = (reg.cprb ? 0 : CPP) + (ratAj || 0) + terceiros; // CPRB: retira os 20% de CPP
          var natC = mapaNat[r.natRubr];
          if (est) { var kri = nrInsc + '|' + comp, ri = ratInfo[kri] = ratInfo[kri] || { nrInsc: nrInsc, comp: comp, est: est, base: 0 }; ri.base += vr; } // base do RAT (T009/T010/T061)
          if (!c && natC && natC.cat === 'naoSalarial') { natUsada = true; acumula('T059', r, vr, aliq, comp, 'natRubr ' + r.natRubr + ' (' + natC.nome + ') com incidência patronal declarada (codIncCP ' + r.codIncCP + ')'); }
          else if (!c && !(REFLEXOS.test(norm(r.dsc)) && ratAj)) semTese[r.dsc] = (semTese[r.dsc] || 0) + vr;
          if (c && c.id === 'T065') pend065.push({ cpf: e.cpf, k: tab + '|' + cod, comp: comp, vr: vr, aliq: aliq, r: r, motivo: c.motivo });
          else if (c) acumula(c.id, r, vr, aliq, comp, c.motivo);
          if (REFLEXOS.test(norm(r.dsc)) && ratAj) {
            reflexos.base += vr; reflexos.valor += vr * ratAj; reflexos.porComp[comp] = (reflexos.porComp[comp] || 0) + vr * ratAj;
            if (comp >= limite) { reflexos.baseNoPrazo += vr; reflexos.valorNoPrazo += vr * ratAj; }
            var kr = tab + '|' + cod, xr = reflexos.rubricas[kr] = reflexos.rubricas[kr] || { cod: cod, tab: tab, dsc: r.dsc, natRubr: r.natRubr, codIncCP: r.codIncCP, motivo: 'reflexo (13º, DSR ou dias não trabalhados)', base: 0 };
            xr.base += vr;
          }
        });
        if (e.tipo === 'S-2299' && av.aviso > 0 && av.real <= 0) { // T076 estimada: 1/12 do aviso, limitada ao 13º com incidência pago na rescisão
          if (av.d13 > 0) acumula('T076', { tab: 'S-2299', cod: 'aviso/12', dsc: '13º proporcional ao aviso-prévio indenizado (1/12 do aviso, estimado)', natRubr: '', codIncCP: '12' }, Math.min(av.aviso / 12, av.d13), (reg.cprb ? 0 : CPP) + (ratAj || 0) + terceiros, comp, 'estimado: 1/12 do aviso-prévio indenizado, limitado ao 13º com incidência pago na rescisão'), n76est++;
          else n76sem++;
        }
        if (!est) avisos.push('Estabelecimento ' + nrInsc + ' sem S-1005: RAT e FAP não aplicados nas competências dele.');
      });
    });

    // T065: habitualidade — mesma rubrica, mesmo trabalhador, 3 ou mais competências dentro de 12 meses => habitual (fora da T065)
    var idxMes = function (c) { return +c.slice(0, 4) * 12 + (+c.slice(5, 7)); };
    var grupos = {}; pend065.forEach(function (p) { (grupos[p.cpf + '|' + p.k] = grupos[p.cpf + '|' + p.k] || []).push(p); });
    var hab = { base: 0, valor: 0, n: 0 };
    Object.keys(grupos).forEach(function (g) {
      var itensG = grupos[g], ms = {}; itensG.forEach(function (p) { ms[idxMes(p.comp)] = 1; });
      var lm = Object.keys(ms).map(Number).sort(function (a, b) { return a - b; }), habitual = {};
      lm.forEach(function (m0) { var jan = lm.filter(function (m) { return m >= m0 && m <= m0 + 11; }); if (jan.length >= 3) jan.forEach(function (m) { habitual[m] = 1; }); });
      itensG.forEach(function (p) {
        if (habitual[idxMes(p.comp)]) { hab.base += p.vr; hab.valor += p.vr * p.aliq; hab.n++; } else acumula('T065', p.r, p.vr, p.aliq, p.comp, p.motivo);
      });
    });
    if (hab.n) avisos.push('Gratificações/prêmios pagos de forma habitual (mesma rubrica, mesmo trabalhador, 3 ou mais competências em 12 meses) foram descartados da T065: ' + hab.n + ' lançamento(s), base ' + brl(hab.base) + ', contribuição estimada ' + brl(hab.valor) + '.');

    // T074: INSS do segurado retido acima do devido pela tabela progressiva (por trabalhador e competência)
    var inssPorComp = {}, n13 = 0, nSemBase = 0, semTabela = {}, conferirTab = {};
    Object.keys(inssRet).forEach(function (k) {
      var comp = k.split('|')[1];
      if (inssDecimo[k]) { n13++; return; }
      var tab = tabelaInss(compMes(comp)); if (!tab) { semTabela[comp] = 1; return; }
      var base = inssBase[k] || 0; if (base <= 0) { nSemBase++; return; }
      if (tab.conferir) conferirTab[comp.slice(0, 4)] = 1;
      var retido = Math.round(inssRet[k] * 100) / 100, devido = contribInss(base, tab), exc2 = Math.round((retido - devido) * 100) / 100;
      var x = inssPorComp[comp] = inssPorComp[comp] || { competencia: comp, trabalhadores: 0, salario: 0, devido: 0, retido: 0, excesso: 0, comExcesso: 0 };
      x.trabalhadores++; x.salario += base; x.devido += devido; x.retido += retido;
      if (exc2 > 0.05) { x.excesso += exc2; x.comExcesso++; }
    });
    var inssLista = Object.keys(inssPorComp).sort().map(function (c) { var x = inssPorComp[c]; return { competencia: c, trabalhadores: x.trabalhadores, comExcesso: x.comExcesso, salario: Math.round(x.salario * 100) / 100, devido: Math.round(x.devido * 100) / 100, retido: Math.round(x.retido * 100) / 100, excesso: Math.round(x.excesso * 100) / 100, noPrazo: c >= limite }; });
    inssLista.forEach(function (x) {
      if (x.excesso > 0) acumula('T074', { tab: 'INSS', cod: 'segurado', dsc: 'INSS do segurado retido acima do devido (tabela progressiva)', natRubr: '9201', codIncCP: '31' }, x.excesso, 1, x.competencia, 'INSS do segurado descontado a maior ou em duplicidade');
    });
    if (n13) avisos.push('INSS do segurado: ' + n13 + ' trabalhador(es)/competência com 13º salário não foram calculados na T074 (tabela e base do 13º são separadas).');
    if (nSemBase) avisos.push('INSS do segurado: ' + nSemBase + ' trabalhador(es)/competência com desconto de INSS, mas sem base de cálculo identificada (tpRubr 1 com incidência 11/21), foram ignorados na T074.');
    if (Object.keys(semTabela).length) avisos.push('INSS do segurado: sem tabela progressiva para as competências ' + Object.keys(semTabela).sort().join(', ') + ' (antes de 03/2020 a alíquota não era progressiva): requer conferência manual e não entrou na T074.');
    if (Object.keys(conferirTab).length) avisos.push('INSS do segurado: tabela de ' + Object.keys(conferirTab).sort().join(', ') + ' a conferir com a portaria interministerial vigente antes de usar o valor.');

    // T009 (FAP), T010 (RAT/GILRAT) e T061 (RAT por atividade preponderante): sobre a base do RAT por estabelecimento e competência
    var headTot = {}, prep = null, semGrau = {}, subRat = {}, parcial = false, semRat = {}, fapInformado = opts.fapPublicado != null, grauCache = {};
    Object.keys(headEst).sort().forEach(function (nr) { headTot[nr] = Object.keys(headEst[nr]).length; if (prep === null || headTot[nr] > headTot[prep]) prep = nr; });
    var pseudo = function (nr, dsc) { return { tab: 'RAT', cod: nr, dsc: dsc, natRubr: '', codIncCP: '' }; };
    Object.keys(ratInfo).sort().forEach(function (k) {
      var ri = ratInfo[k], est = ri.est, nr = ri.nrInsc, fap = est.fap, rat = est.rat;
      if (!(rat > 0)) { semRat[nr] = 1; return; }
      var pub = fapDe(opts.fapPublicado, nr, compMes(ri.comp));
      if (pub != null && fap > pub) acumula('T009', pseudo(nr, 'FAP aplicado ' + fap + ' × FAP revisado ' + pub + ' (RAT ' + rat + '%)'), ri.base, rat / 100 * (fap - pub), ri.comp, 'FAP aplicado ' + fap + ' acima do FAP revisado ' + pub);
      var ck = nr + '|' + est.cnae; if (!(ck in grauCache)) grauCache[ck] = grauCnae(est.cnae, opts.cnaeRisco); var gr = grauCache[ck];
      if (!gr) { semGrau[nr + ' (CNAE ' + (est.cnae || 'não informado') + ')'] = 1; return; }
      if (gr.fonte === 'tabela-parcial') parcial = true;
      if (rat < gr.grau) { subRat[nr + ' (CNAE ' + est.cnae + ': grau ' + gr.grau + ', declarado ' + rat + ')'] = 1; return; }
      if (rat === gr.grau) return;
      var pe = prep && prep !== nr && estabs[prep] ? vigente(estabs[prep], compMes(ri.comp)) : null, difAliq = (rat - gr.grau) / 100 * fap;
      if (pe && pe.rat === rat) acumula('T061', pseudo(nr, 'RAT ' + rat + '% igual ao do estabelecimento preponderante (' + prep + '); grau do próprio CNAE ' + est.cnae + ': ' + gr.grau), ri.base, difAliq, ri.comp, 'RAT do estabelecimento preponderante aplicado acima do grau do CNAE do estabelecimento');
      else acumula('T010', pseudo(nr, 'RAT declarado ' + rat + '% × grau de risco ' + gr.grau + ' do CNAE ' + est.cnae), ri.base, difAliq, ri.comp, 'RAT declarado acima do grau de risco do CNAE');
    });
    var ratPrep = null;
    if (prep) {
      var lotsP = Object.keys(headLot).filter(function (k) { return k.split('|')[0] === prep; }).map(function (k) { return { cod: k.split('|')[1], empregados: Object.keys(headLot[k]).length }; }).sort(function (a, b) { return b.empregados - a.empregados; });
      var ep = estabs[prep] ? vigente(estabs[prep], Object.keys(comps).sort().pop() || '9999-12') : null;
      ratPrep = { nrInsc: prep, cnae: ep ? ep.cnae : '', ratAplicado: ep ? ep.rat : null, empregadosCompetencias: headTot[prep], lotacoes: lotsP,
        estabelecimentos: Object.keys(headTot).map(function (nr) { return { nrInsc: nr, empregadosCompetencias: headTot[nr] }; }) };
    }
    if (ratInfo && Object.keys(ratInfo).length && !fapInformado) avisos.push('T009 (revisão do FAP): informe o FAP revisado (extrato do FAP na Dataprev/Previdência) para calcular; sem ele o valor é zero.');
    if (Object.keys(semGrau).length) avisos.push('T010/T061: CNAE sem grau de risco na tabela parcial (' + Object.keys(semGrau).sort().join('; ') + '): informe o grau do Anexo V (opts.cnaeRisco) para calcular; valor zero.');
    if (parcial && (porTese.T010 || porTese.T061)) avisos.push('T010/T061: grau de risco obtido da tabela parcial de CNAE — CONFERIR com o Anexo V do Decreto 3.048/99.');
    if (Object.keys(subRat).length) avisos.push('RAT declarado ABAIXO do grau de risco do CNAE (possível passivo, não é crédito): ' + Object.keys(subRat).sort().join('; ') + '.');
    if (Object.keys(semRat).length) avisos.push('S-1005 sem alíquota RAT (aliqRat) nos estabelecimentos ' + Object.keys(semRat).sort().join(', ') + ': T009/T010/T061 não calculadas.');
    if ([porTese.T009, porTese.T010, porTese.T061].filter(Boolean).length > 1) avisos.push('T009, T010 e T061 incidem sobre a mesma base de RAT: conferir a sobreposição antes de somar os valores.');
    if (natUsada) avisos.push('Rubricas classificadas por natRubr usam o mapa PARCIAL da Tabela 3 do eSocial: CONFERIR com a Tabela 3 oficial.');
    if (porTese.T059) avisos.push('T059: rubricas de natureza não salarial com incidência declarada; se houver tese específica para a verba, usar a específica para não duplicar.');
    if (Object.keys(incoerencias).length) avisos.push('Incoerência natRubr × incidência (natureza salarial sem incidência patronal declarada: possível passivo, conferir): ' + Object.keys(incoerencias).sort().slice(0, 8).join('; ') + '.');
    if (n76est) avisos.push('T076 estimada em ' + n76est + ' rescisão(ões): 1/12 do aviso-prévio indenizado, limitado ao 13º com incidência pago. A incidência no 13º proporcional ao aviso é controvertida (a RFB entende que incide); a tese depende de decisão da empresa.');
    if (n76sem) avisos.push('T076: ' + n76sem + ' rescisão(ões) com aviso-prévio indenizado sem 13º com incidência na mesma rescisão: sem valor estimado.');

    // T008 (exceção): terceiros sobre o que excede 20 salários mínimos por trabalhador e competência
    if (exc) {
      var t8 = { id: 'T008', nome: NOMES.T008, base: 0, baseNoPrazo: 0, valor: 0, valorNoPrazo: 0, rubricas: {}, competencias: {}, porComp: {} };
      Object.keys(baseTrab).forEach(function (k) {
        var comp = k.split('|')[1], sm = salarioMinimo(compMes(comp));
        if (sm == null) { semSM[comp] = 1; return; }
        var excesso = Math.max(0, baseTrab[k] - 20 * sm); if (excesso <= 0) return;
        t8.base += excesso; t8.valor += excesso * terceiros; t8.competencias[comp] = 1; t8.porComp[comp] = (t8.porComp[comp] || 0) + excesso * terceiros;
        if (comp >= limite) { t8.baseNoPrazo += excesso; t8.valorNoPrazo += excesso * terceiros; }
      });
      if (t8.base > 0) porTese.T008 = t8;
      if (Object.keys(semSM).length) avisos.push('T008: sem salário mínimo na tabela para as competências ' + Object.keys(semSM).sort().join(', ') + ' (não calculadas).');
      avisos.push('T008 pode se sobrepor à parcela de terceiros das demais teses para trabalhadores acima de 20 salários mínimos: conferir antes de somar.');
    }
    if (reflexos.base > 0) porTese.T069 = { id: 'T069', nome: NOMES.T069, base: reflexos.base, baseNoPrazo: reflexos.baseNoPrazo, valor: reflexos.valor, valorNoPrazo: reflexos.valorNoPrazo, rubricas: reflexos.rubricas, competencias: {}, porComp: reflexos.porComp };
    if (porTese.T005 && !porTese.T076) avisos.push('13º sobre aviso-prévio indenizado: decisão pendente');

    // escopo: ok = ao menos uma competência no escopo (ou nenhuma competência apurada)
    var cs = Object.keys(comps).sort(), exclLista = Object.keys(excluidas).sort();
    var ultimo = historico[historico.length - 1] || null;
    var todasFora = cs.length > 0 && exclLista.length === cs.length;
    var escopo = { ok: !todasFora || forcar, classTrib: ultimo ? ultimo.classTrib : '', cprb: ultimo ? ultimo.cprb : false, motivo: null, historico: historico, competenciasExcluidas: exclLista, forcado: false };
    var rotulo = Object.keys(classExcl).sort().join(', ');
    if (todasFora) {
      escopo.motivo = 'regime fora do escopo (classTrib ' + rotulo + ')';
      if (forcar) { escopo.forcado = true; escopo.ok = false; avisos.unshift('Escopo forçado: ' + escopo.motivo + '. Cálculo feito assim mesmo, sem validade para o regime.'); }
      else { escopo.ok = false; avisos.unshift('Cálculo bloqueado: ' + escopo.motivo + '. A ferramenta atende só Lucro Real/Presumido (classTrib 99).'); porTese = {}; }
    } else if (exclLista.length) {
      var txtC = exclLista.length > 12 ? exclLista.slice(0, 12).join(', ') + ' e mais ' + (exclLista.length - 12) : exclLista.join(', ');
      if (forcar) { escopo.forcado = true; avisos.unshift('Escopo forçado: competências com regime fora do escopo (classTrib ' + rotulo + ') foram calculadas assim mesmo: ' + txtC + '.'); }
      else avisos.unshift('Competências excluídas do cálculo por regime fora do escopo (classTrib ' + rotulo + '): ' + txtC + '.');
    }
    if (regimeNaoIdent) avisos.push('Regime não identificado (sem S-1000/classTrib ou competência fora das vigências): competências sem regime foram calculadas como Lucro Real/Presumido.');
    if (Object.keys(cprbComps).length) avisos.push('CPRB (indDesFolha = 1) nas competências ' + Object.keys(cprbComps).sort().join(', ') + ': alíquota patronal = RAT×FAP + terceiros, sem os 20% de CPP.');

    var r2 = function (v) { return Math.round(v * 100) / 100; };
    var teses = Object.keys(porTese).map(function (id) {
      var t = porTese[id];
      return { id: id, nome: t.nome, base: r2(t.base), baseNoPrazo: r2(t.baseNoPrazo), valor: r2(t.valor), valorNoPrazo: r2(t.valorNoPrazo),
        competencias: Object.keys(t.competencias).length,
        condicional: !!CONDICOES[id], condicao: CONDICOES[id] || null,
        porCompetencia: Object.keys(t.porComp).sort().map(function (k) { return { competencia: k, valor: r2(t.porComp[k]), noPrazo: k >= limite }; }), // valor por competência (base da atualização pela Selic)
        rubricas: Object.keys(t.rubricas).map(function (k) { var x = t.rubricas[k]; return Object.assign({}, x, { base: r2(x.base) }); }).sort(function (a, b) { return b.base - a.base; }) };
    }).sort(function (a, b) { return b.valorNoPrazo - a.valorNoPrazo; });
    // sensibilidade da borda: competência do limite (dentro) x a imediatamente anterior (fora; entraria se o prazo contasse do dia do pagamento, dia 20 do mês seguinte)
    var totComp = function (c) { return r2(Object.keys(porTese).reduce(function (s, id) { return s + (porTese[id].porComp[c] || 0); }, 0)); };
    var sens = cs.length && teses.length ? { limite: limite, dentro: totComp(limite), fora: totComp(mesAnterior(limite)) } : null;
    if (!contagem['S-1010']) avisos.unshift('Faltam os eventos S-1010 (tabela de rubricas): sem eles não é possível saber a incidência de cada rubrica.');
    if (!contagem['S-1200'] && !contagem['S-2299']) avisos.unshift('Faltam os eventos S-1200 (remuneração): sem eles não há base para o cálculo.');
    if (!contagem['S-1005']) avisos.push('Faltam os eventos S-1005 (estabelecimentos): o RAT ajustado pelo FAP não foi aplicado.');
    var lista = function (o) { return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; }).slice(0, 8).join('; '); };
    if (Object.keys(semIncidencia).length) avisos.push('Rubricas sem incidência patronal declarada no S-1010 (só rubricas de vencimento com código de incidência 11, 12, 21 ou 22 entram no cálculo): ' + lista(semIncidencia) + '.');
    if (Object.keys(semTese).length) avisos.push('Rubricas com incidência, mas sem tese associada pela descrição (a equipe técnica deve classificar): ' + lista(semTese) + '.');
    Object.keys(semCadastro).slice(0, 20).forEach(function (k) { avisos.push('Rubrica ' + k.split('|')[1] + ' (tabela ' + k.split('|')[0] + ') usada na folha sem cadastro no S-1010.'); });
    return {
      versaoMotor: VERSAO, geradoEm: new Date().toISOString(), empregador: empregador,
      periodo: { inicio: cs[0] || null, fim: cs[cs.length - 1] || null, competencias: cs.length,
        competenciasNominais: cs.filter(function (c) { return !/\/13$/.test(c); }).length,
        competenciasDecimoTerceiro: cs.filter(function (c) { return /\/13$/.test(c); }).length }, limitePrazo: limite,
      eventos: contagem, trabalhadoresCompetencias: Object.keys(remun).length,
      estabelecimentos: Object.keys(estabs).map(function (k) { var e = vigente(estabs[k], compMes(cs[cs.length - 1] || '9999-12')); return { nrInsc: k, cnae: e.cnae, rat: e.rat, fap: e.fap }; }),
      lotacoes: Object.keys(lotacoes).map(function (k) { var x = lotacoes[k][lotacoes[k].length - 1]; return { cod: k, fpas: x.fpas, codTercs: x.codTercs }; }),
      premissas: { cpp: CPP, terceiros: terceiros, incidencias: Object.keys(INCIDE_PATRONAL), terceirosExcecao: exc },
      escopo: escopo,
      teses: teses,
      total: { valor: r2(teses.reduce(function (s, t) { return s + t.valor; }, 0)), valorNoPrazo: r2(teses.reduce(function (s, t) { return s + t.valorNoPrazo; }, 0)) },
      rescisoes: { eventos: contagem['S-2299'], exclusoes: { encontradas: exclusoes.length, pareadas: pareadas } },
      inssSegurado: inssLista.length ? { porCompetencia: inssLista, principal: Math.round(inssLista.reduce(function (s, x) { return s + x.excesso; }, 0) * 100) / 100 } : null,
      sensibilidadeBorda: sens,
      ratPreponderante: ratPrep,
      dependencias: ['T009', 'T010', 'T061', 'T059', 'T076'].map(function (id) {
        var tem = !!porTese[id], st;
        if (tem) st = 'calculada';
        else if (id === 'T009') st = ratInfo && Object.keys(ratInfo).length ? (fapInformado ? 'sem-diferenca' : 'aguardando-dado') : 'sem-dados';
        else if (id === 'T010' || id === 'T061') st = !Object.keys(ratInfo).length ? 'sem-dados' : (Object.keys(semGrau).length ? 'aguardando-dado' : (id === 'T061' && Object.keys(headEst).length < 2 ? 'nao-aplicavel' : 'sem-diferenca'));
        else st = 'sem-ocorrencia';
        return { id: id, nome: NOMES[id], status: st, documentos: DOCUMENTOS[id] };
      }),
      pagamento: 'nao-confirmado', // os valores são estimativa: pagamento da contribuição não confirmado (GFIP/DCTFWeb/DARF)
      rubricasAnalisadas: Object.keys(rubricasUsadas).length,
      avisos: avisos.filter(function (a, i) { return avisos.indexOf(a) === i; })
    };
  }

  // apuração completa: núcleo + módulo extra (T077–T096). O extra roda primeiro para informar as rubricas que mudam de tese.
  function apurar(lidos, opts) {
    opts = opts || {};
    var Extra = (typeof module !== 'undefined' && module.exports) ? (function () { try { return require('./motor-esocial-extra.js'); } catch (e) { return null; } })() : root.MotorEsocialExtra;
    if (!Extra || opts.semExtra) return apurarBase(lidos, opts);
    var ex = Extra.apurarExtra(lidos, Object.assign({}, opts, { classificar: classificar }));
    var excl = {}; (ex.reclassifica || []).forEach(function (r) { excl[r.de + '|' + r.rubrica] = 1; });
    var r = apurarBase(lidos, Object.assign({}, opts, { _excluir: excl }));
    if (!r.escopo.ok && !r.escopo.forcado) { r.requerDocumento = []; return r; }
    var r2 = function (v) { return Math.round(v * 100) / 100; };
    r.teses = r.teses.filter(function (t) { return t.valor > 0 || t.valorNoPrazo > 0 || !excl[t.id]; }).concat(ex.teses.filter(function (t) { return t.natureza !== 'planejamento'; }))
      .sort(function (a, b) { return b.valorNoPrazo - a.valorNoPrazo; });
    r.planejamento = ex.teses.filter(function (t) { return t.natureza === 'planejamento'; });
    r.total = { valor: r2(r.teses.reduce(function (s, t) { return s + t.valor; }, 0)), valorNoPrazo: r2(r.teses.reduce(function (s, t) { return s + t.valorNoPrazo; }, 0)) };
    r.requerDocumento = ex.requerDocumento || [];
    r.reclassificadas = ex.reclassifica || [];
    r.avisos = r.avisos.concat(ex.avisos || []).filter(function (a, i, arr) { return arr.indexOf(a) === i; });
    r.versaoExtra = ex.versao;
    return r;
  }

  var api = { VERSAO: VERSAO, lerXml: lerXml, apurar: apurar, classificar: classificar, parseXml: parseXml, INCIDE_PATRONAL: INCIDE_PATRONAL, NOMES: NOMES, SALARIO_MINIMO: SALARIO_MINIMO, CONDICOES: CONDICOES, NAT_RUBR: NAT_RUBR, CNAE_RISCO: CNAE_RISCO, DOCUMENTOS: DOCUMENTOS, classificarRub: classificarRub, grauCnae: grauCnae, INSS_TABELAS: INSS_TABELAS, contribInss: contribInss, tabelaInss: tabelaInss };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MotorEsocial = api;
})(typeof self !== 'undefined' ? self : this);
