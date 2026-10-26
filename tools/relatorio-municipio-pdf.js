// Relatório do diagnóstico municipal (PDF, A4) — espelha a estrutura do relatório do Reversa Tax:
//   capa · critério de classificação (CPC 25) · cálculo preliminar do total recuperável ·
//   diagnóstico fiscal · diagnóstico previdenciário · diagnóstico consolidado (próximos passos) ·
//   apuração do motor · anexo (memória de cálculo, proveniência, ressalvas e registro de bugs).
// O diagnóstico não é crédito (RB-09): aponta onde procurar, não reconhece valor.
//
//   node tools/relatorio-municipio-pdf.js <diagnostico.json> <folha.json> <saida.pdf>
const path = require('node:path');
const fs = require('node:fs');
const PDFDocument = require('pdfkit');

const FONTES = path.join(__dirname, '..', 'assets', 'fonts');
const LOGO = path.join(__dirname, '..', 'assets', 'reversa-r.png');
// Mesma paleta do relatório do Tax: branco predominante, grafite esverdeado, esmeralda e ouro velho em detalhes.
const C = {
  tinta: '#1D2B27', texto: '#2E3733', muted: '#6E7773', claro: '#A3A9A5', linha: '#E4E0D6', fundo: '#F8F7F3',
  esmeralda: '#0E7A5C', ouro: '#A9864F', remoto: '#8C9591'
};
const CLASSE = { verde: ['Provável', C.esmeralda], amarelo: ['Possível', C.ouro], vermelho: ['Remoto', C.remoto] };
const M = 56;

const reais = (v) => (v == null ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const num = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inteiro = (v) => Number(v || 0).toLocaleString('pt-BR');
const pct = (v, d = 2) => (v == null || !isFinite(v) ? '—' : (v * 100).toFixed(d).replace('.', ',') + '%');
const dataLonga = () => new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' });
const dataBr = (iso) => String(iso || '').replace(/^(\d{4})-(\d{2})-(\d{2}).*$/, '$3/$2/$1');
const capitular = (t) => String(t).toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase());

// ------------------------------------------------------------------ dados
function carregar() {
  const [arqDiag, arqFolha, arqOut] = process.argv.slice(2);
  if (!arqDiag || !arqOut) {
    console.error('uso: node tools/relatorio-municipio-pdf.js <diagnostico.json> <folha.json> <saida.pdf>');
    process.exit(1);
  }
  const diag = JSON.parse(fs.readFileSync(arqDiag, 'utf8'));
  const folha = arqFolha && fs.existsSync(arqFolha) ? JSON.parse(fs.readFileSync(arqFolha, 'utf8')) : [];

  const porAno = new Map();
  const porComp = new Map();
  for (const r of folha) {
    const ano = String(r.mesReferencia).slice(0, 4);
    if (!porAno.has(ano)) porAno.set(ano, { ano, comps: new Set(), bruto: 0, base: 0, desc: 0, n13: 0, bruto13: 0, base13: 0, desc13: 0 });
    const a = porAno.get(ano);
    a.comps.add(r.mesReferencia);
    a.bruto += Number(r.vlrSalarioBruto || 0); a.base += Number(r.vlrSalarioBase || 0); a.desc += Number(r.vlrDesconto || 0);
    if (['P13', 'A13'].includes(r.indRotina)) { a.n13++; a.bruto13 += Number(r.vlrSalarioBruto || 0); a.base13 += Number(r.vlrSalarioBase || 0); a.desc13 += Number(r.vlrDesconto || 0); }
    const c = r.mesReferencia;
    if (!porComp.has(c)) porComp.set(c, { comp: c, n: 0, bruto: 0, desc: 0 });
    const x = porComp.get(c);
    x.n++; x.bruto += Number(r.vlrSalarioBruto || 0); x.desc += Number(r.vlrDesconto || 0);
  }
  const anos = [...porAno.values()].sort((a, b) => a.ano.localeCompare(b.ano));
  const serie = (diag.serieSiconfi && diag.serieSiconfi.serie) || [];
  const rec = diag.recuperavelPreliminar || { totalCents: 0, itens: [] };
  return { diag, folha, porAno, porComp, anos, serie, rec, arqOut };
}

function gerar(d) {
  const { diag, anos, serie, rec, porComp } = d;
  // --- CAixas complementares: DCA (obrigações patronais), recálculo do ISSQN, piso do PNCP ---
  const lerJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
  const DCA_C = lerJson('/workspace/dca-completa-5anos.json');
  const ISSQN_RECALC = lerJson('/workspace/acessos/issqn-recalculo.json') || {};
  const PNCP_PISO = lerJson('/workspace/acessos/pncp-piso-base.json') || {};
  const numDca = (x) => {
    const s = String(x == null ? '' : x).trim();
    if (!s) return 0;
    return s.includes(',') ? parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0 : parseFloat(s) || 0;
  };
  // 3.1.90.13.02 = "Contribuições Previdenciárias - INSS" (rótulo do próprio Tesouro).
  // Piso legal = 20% da cota patronal (Lei 8.212/1991, art. 22, III, "a") sobre a despesa
  // de pessoal registrada (3.1.90.11 + 3.1.90.04). RAT e terceiros ficam de fora, de propósito.
  const patronal = (DCA_C ? ['2021', '2022', '2023', '2024', '2025'] : []).map((ano) => {
    const linhas = Array.isArray(DCA_C[ano]) ? DCA_C[ano] : [];
    const acc = { pessoal: 0, clt: 0, patronal: 0, empenhado: 0, rapInscrito: 0 };
    for (const r of linhas) {
      const c = String(r.cod_conta || '');
      const v = numDca(r.valor);
      if (!v) continue;
      if (r.coluna === 'Despesas Pagas') {
        if (c === 'DO3.1.90.11.00.00') acc.pessoal += v;
        else if (c === 'DO3.1.90.04.00.00') acc.clt += v;
        else if (c === 'DO3.1.90.13.00.00') acc.patronal += v;
      } else if (r.coluna === 'Despesas Empenhadas' && c === 'DO3.1.90.13.00.00') acc.empenhado += v;
      else if (c === 'DO3.1.90.13.00.00' && String(r.coluna).indexOf('Inscritos em 31 de Dezembro') >= 0) acc.rapInscrito += v;
    }
    const massa = acc.pessoal + acc.clt;
    const piso = massa * 0.20;
    return { ano, massa, ...acc, piso20: piso, diferenca: piso - acc.patronal, razao: acc.patronal / (massa || 1) };
  });
  const gap2425 = patronal.filter((x) => x.ano === '2024' || x.ano === '2025');
  const gap2425Total = gap2425.reduce((s, x) => s + x.diferenca, 0);
  const gap25 = gap2425.find((x) => x.ano === '2025');
  const municipio = diag.municipio || 'Município';
  const uf = diag.uf || '';
  const tituloDoc = 'Diagnóstico de Oportunidades Tributárias e Previdenciárias';
  const rotuloDoc = 'Diagnóstico preliminar · Reversa Gov';

  const doc = new PDFDocument({ size: 'A4', margins: { top: 72, bottom: 72, left: M, right: M }, bufferPages: true,
    info: { Title: `${tituloDoc} — ${municipio}`, Author: 'Reversa Gov · Argus Prime', Subject: rotuloDoc } });
  doc.registerFont('R', path.join(FONTES, 'Inter-Regular.otf'));
  doc.registerFont('M', path.join(FONTES, 'Inter-Medium.otf'));
  doc.registerFont('S', path.join(FONTES, 'Inter-SemiBold.otf'));
  doc.registerFont('B', path.join(FONTES, 'Inter-Bold.otf'));
  doc.registerFont('T', path.join(FONTES, 'Lora-Variable.ttf'));
  const W = doc.page.width, H = doc.page.height, LW = W - 2 * M;
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const fim = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  // ------------------------------------------------------------------ utilitários de página
  let y = 0;
  const novaPagina = () => { doc.addPage(); doc.x = M; doc.y = 72; };
  const espaco = (h) => { if (doc.y + h > H - 84) { novaPagina(); return true; } return false; };
  const regua = (yy, cor = C.linha, lw = 0.5, x0 = M, x1 = W - M) => doc.moveTo(x0, yy).lineTo(x1, yy).lineWidth(lw).strokeColor(cor).stroke();
  const par = (t, o = {}) => doc.font(o.f || 'R').fontSize(o.s || 9.5).fillColor(o.c || C.texto)
    .text(t, o.x ?? M, o.y ?? doc.y, { width: o.w ?? LW, lineGap: o.lg ?? 2.6, align: o.align || 'left' });
  let nSecao = 0;
  const secao = (titulo) => {
    novaPagina(); nSecao += 1;
    doc.font('S').fontSize(7.5).fillColor(C.ouro).text(String(nSecao).padStart(2, '0'), M, doc.y, { characterSpacing: 1.5 });
    doc.font('T').fontSize(19).fillColor(C.tinta).text(titulo, M, doc.y + 2, { width: LW });
    y = doc.y + 8; doc.rect(M, y, 28, 1.2).fill(C.esmeralda);
    doc.y = y + 18;
  };
  const subtitulo = (t, extra) => {
    espaco(60); doc.moveDown(0.7);
    y = doc.y;
    doc.font('S').fontSize(10.5).fillColor(C.tinta).text(t, M, y, { lineBreak: false });
    if (extra) doc.font('R').fontSize(8.5).fillColor(C.muted).text(extra, M, y + 1.5, { width: LW, align: 'right' });
    doc.y = y + 17; regua(doc.y, C.tinta, 0.6); doc.y += 8;
  };

  // ------------------------------------------------------------------ capa
  doc.page.margins.bottom = 0;
  doc.image(LOGO, W - M - 150, 52, { height: 44 });
  doc.font('B').fontSize(13).fillColor(C.tinta).text('REVERSA', W - M - 100, 58, { lineBreak: false, characterSpacing: 1.6 });
  doc.font('B').fontSize(13).fillColor(C.esmeralda).text('GOV', W - M - 100 + doc.font('B').fontSize(13).widthOfString('REVERSA ', { characterSpacing: 1.6 }) + 4, 58, { lineBreak: false, characterSpacing: 1.6 });
  doc.font('R').fontSize(8.5).fillColor(C.muted).text('uma solução Argus Prime', W - M - 100, 78, { lineBreak: false });
  doc.font('S').fontSize(8).fillColor(C.ouro).text('DIAGNÓSTICO PRELIMINAR', M, 292, { characterSpacing: 2 });
  doc.font('T').fontSize(27).fillColor(C.tinta).text(tituloDoc, M, 312, { width: LW - 60, lineGap: 4 });
  y = doc.y + 20; doc.rect(M, y, 36, 1.4).fill(C.esmeralda);
  doc.font('S').fontSize(13).fillColor(C.tinta).text(`Prefeitura de ${capitular(municipio)}`, M, y + 22, { width: LW });
  doc.font('R').fontSize(9.5).fillColor(C.muted).text(`IBGE ${diag.ibgeCode || '—'}   ·   ${capitular(municipio)}/${uf}`, M, doc.y + 6, { width: LW });
  doc.text('Escopo: Fiscal (IRRF e ISSQN) e Previdenciário (folha de pagamento)', M, doc.y + 3, { width: LW });
  doc.text(`Fonte: dados públicos do Siconfi (Tesouro Nacional) e do portal de transparência do município · ${serie.length} anos`, M, doc.y + 3, { width: LW });
  doc.font('R').fontSize(9).fillColor(C.texto).text(`${dataLonga()}   ·   Preparado pelo time técnico Argus Prime`, M, H - 140, { width: LW });
  doc.font('R').fontSize(7.5).fillColor(C.muted).text('Documento confidencial, de uso exclusivo do destinatário. Diagnóstico preliminar: indica oportunidades a confirmar e não constitui reconhecimento de crédito. ' +
    'Nenhum valor aqui é lançamento contábil sem conferência do contador e sem os documentos autorizados.', M, H - 122, { width: LW * 0.78, lineGap: 2 });
  doc.rect(0, H - 5, W * 0.7, 5).fill(C.esmeralda); doc.rect(W * 0.7, H - 5, W * 0.3, 5).fill(C.ouro);
  doc.page.margins.bottom = 72;

  // ------------------------------------------------------------------ 1. critério de classificação
  secao('Critério de classificação');
  par('Cada oportunidade é classificada pela chance de êxito e pela solidez da prova disponível, conforme o conceito do Pronunciamento Técnico CPC 25 (Provisões, Passivos Contingentes e Ativos Contingentes), aprovado pela Resolução CVM 72/2022. No âmbito municipal, a classificação depende ainda da evidência documental: retenção comprovada no documento, base de cálculo declarada e alíquota aplicável vigente.');
  doc.moveDown(1);
  const cx = [M, M + 92, M + 370], cw = [84, 262, LW - 370];
  y = doc.y;
  doc.font('S').fontSize(7.5).fillColor(C.muted);
  doc.text('CLASSIFICAÇÃO', cx[0], y, { characterSpacing: 0.8, lineBreak: false });
  doc.text('DEFINIÇÃO', cx[1], y, { characterSpacing: 0.8, lineBreak: false });
  doc.text('TRATAMENTO', cx[2], y, { characterSpacing: 0.8, lineBreak: false });
  doc.y = y + 14; regua(doc.y, C.tinta, 0.6);
  [['verde', 'Chance de êxito maior que a de perda, com prova documental completa: retenção comprovada, base declarada no documento e alíquota vigente confirmada.', 'Recomendada'],
    ['amarelo', 'Chance real de êxito, mas depende de prova que ainda não está no processo: destino do valor, base do cálculo ou alíquota do documento.', 'Recomendada, com análise da prova'],
    ['vermelho', 'Chance pequena de êxito: sem retenção na fonte, sem destinação provada ou com vedação expressa na legislação.', 'Cabe análise específica']
  ].forEach(([k, def, trat]) => {
    doc.font('R').fontSize(9);
    const h = Math.max(doc.heightOfString(def, { width: cw[1], lineGap: 2.4 }), doc.heightOfString(trat, { width: cw[2], lineGap: 2.4 })) + 18;
    y = doc.y;
    doc.rect(cx[0], y + 9, 2, 11).fill(CLASSE[k][1]);
    doc.font('S').fontSize(9.5).fillColor(CLASSE[k][1]).text(CLASSE[k][0], cx[0] + 9, y + 9, { lineBreak: false });
    doc.font('R').fontSize(9).fillColor(C.texto).text(def, cx[1], y + 9, { width: cw[1], lineGap: 2.4 });
    doc.text(trat, cx[2], y + 9, { width: cw[2], lineGap: 2.4 });
    doc.y = y + h; regua(doc.y);
  });
  doc.moveDown(1.4);
  par('Pelo CPC 25, o crédito só é reconhecido contabilmente quando sua realização é praticamente certa: quando decorre diretamente da legislação, está assegurado por decisão judicial definitiva ou por habilitação perante a autoridade competente. Até lá, o valor é uma expectativa de recuperação. Este documento é um diagnóstico preliminar: ele estima o teto e aponta a prova que falta. Nada aqui é crédito reconhecido, e o motor não tem como reconhecer — essa é uma decisão humana, com documento autorizado.', { c: C.texto });
  doc.moveDown(1.2);
  doc.font('S').fontSize(9.5).fillColor(C.tinta).text('Fontes consideradas', M, doc.y); doc.moveDown(0.3);
  par('Siconfi — Demonstrativo da Aplicação dos Recursos (DCA) do Tesouro Nacional, com retenção de IRRF, ISSQN arrecadado e despesas com serviços de terceiros; portal de transparência do próprio município, com a folha de pagamento publicada; legislação municipal vigente (Código Tributário Municipal — CTM — com a base e as alíquotas do ISSQN, e as regras de retenção); e, quando disponíveis, eSocial, EFD-Reinf, ECD e DCTFWeb.', { c: C.muted, s: 9 });
  doc.moveDown(1);
  doc.font('S').fontSize(9.5).fillColor(C.tinta).text('Natureza deste documento', M, doc.y); doc.moveDown(0.3);
  par('Diagnóstico preliminar, elaborado a partir de dados públicos e do cruzamento com o motor de apuração. Os valores são estimativas, sujeitas à revisão técnica, à validação dos documentos de suporte e à atualização pela Selic. Fonte indisponível é registrada como indisponível — nunca como zero.', { c: C.muted, s: 9 });

  // ------------------------------------------------------------------ 2. cálculo preliminar do total recuperável
  secao('Cálculo preliminar do total recuperável');
  par('O que segue é o cálculo, não uma narrativa. Cada item traz a base usada, o fator legal aplicado, o valor observado na fonte, o valor esperado e o grau de certeza. O total é o teto do que a defasagem de retenção permitiria recuperar: não é crédito reconhecido e cada item declara por que.');
  doc.moveDown(0.8);
  const itemIrrf = (rec.itens || []).find((i) => /IRRF/i.test(i.item)) || {};
  const itemIssqn = (rec.itens || []).find((i) => /ISSQN/i.test(i.item)) || {};
  // cartao do total
  y = doc.y;
  doc.rect(M, y, LW, 74).fill(C.fundo);
  doc.rect(M, y, 3, 74).fill(C.esmeralda);
  doc.font('S').fontSize(8).fillColor(C.muted).text('CÁLCULO DO DIAGNÓSTICO SOBRE DADO PÚBLICO — TETO (R$)', M + 16, y + 12, { characterSpacing: 0.8, lineBreak: false });
  doc.font('B').fontSize(24).fillColor(C.tinta).text(reais((rec.totalCents || 0) / 100), M + 16, y + 26, { lineBreak: false });
  doc.font('R').fontSize(8.6).fillColor(C.texto).text('estimativa do diagnóstico · 5 anos · dado público do Siconfi · sem atualização monetária · NÃO é crédito reconhecido', M + 16, y + 57, { lineBreak: false });
  doc.font('S').fontSize(8).fillColor(C.ouro).text('TETO, NÃO CRÉDITO', M + LW - 150, y + 12, { characterSpacing: 0.8, lineBreak: false, align: 'right' });
  doc.font('R').fontSize(8).fillColor(C.muted).text('A base inclui serviços com alíquota superior a 1,5% e itens isentos:\no valor real é igual ou menor que este teto.', M + LW - 150, y + 28, { width: 150, align: 'right', lineGap: 1.8 });
  doc.y = y + 90;
  doc.moveDown(0.4);

  // memória de cálculo por item
  subtitulo('Memória de cálculo por item');
  const colunas = ['ITEM', 'BASE', 'FATOR', 'OBSERVADO', 'ESPERADO', 'VALOR'];
  const larguras = [128, 80, 46, 78, 80, 71];
  const cabecalho = (y0) => {
    let xx = M;
    doc.font('S').fontSize(7).fillColor(C.muted);
    colunas.forEach((c, i) => { doc.text(c, xx, y0, { width: larguras[i], align: i ? 'right' : 'left', characterSpacing: 0.4, lineBreak: false }); xx += larguras[i]; });
    doc.y = y0 + 12; regua(doc.y, C.tinta, 0.6);
  };
  const linhaItem = (item) => {
    const valores = [
      item.item,
      item.baseCents == null ? '—' : num(item.baseCents / 100),
      item.fator,
      item.observadoCents == null ? '—' : num(item.observadoCents / 100),
      item.esperadoCents == null ? '—' : num(item.esperadoCents / 100),
      item.valorCents == null ? '—' : num(item.valorCents / 100)
    ];
    doc.font('R').fontSize(8.4);
    const h = Math.max(doc.heightOfString(valores[0], { width: larguras[0] - 8, lineGap: 1.8 }), 12) + 14;
    espaco(h + 26);
    y = doc.y + 5;
    let xx = M;
    valores.forEach((v, i) => {
      const forte = i === 5 && item.valorCents != null;
      doc.font(forte ? 'S' : 'R').fontSize(forte ? 9 : 8.4).fillColor(forte ? C.tinta : (i === 0 ? C.texto : C.muted))
        .text(v, xx, y, { width: larguras[i], align: i ? 'right' : 'left', lineBreak: false, ellipsis: true });
      xx += larguras[i];
    });
    doc.y = y + 13;
    doc.font('R').fontSize(7.4).fillColor(C.muted).text(`Base legal: ${item.fatorLegal}`, M, doc.y, { width: LW, lineGap: 1.6 });
    doc.y += doc.heightOfString(`Base legal: ${item.fatorLegal}`, { width: LW, lineGap: 1.6 }) + 1;
    doc.font('R').fontSize(7.4).fillColor(C.muted).text(`Fonte: ${item.fonte}`, M, doc.y, { width: LW, lineGap: 1.6 });
    doc.y += doc.heightOfString(`Fonte: ${item.fonte}`, { width: LW, lineGap: 1.6 }) + 1;
    doc.font('S').fontSize(7).fillColor(item.grau === 'teto' ? C.esmeralda : C.ouro).text(`GRAU: ${String(item.grau).toUpperCase()}`, M, doc.y, { characterSpacing: 0.5, lineBreak: false });
    doc.y += 10;
    doc.font('R').fontSize(7.8).fillColor(C.texto).text(item.nota || '', M, doc.y, { width: LW, lineGap: 1.8 });
    doc.y += doc.heightOfString(item.nota || '', { width: LW, lineGap: 1.8 }) + 6;
    regua(doc.y);
  };
  cabecalho(doc.y);
  (rec.itens || []).forEach(linhaItem);
  doc.moveDown(0.6);
  par('Unidade: valores em reais. A série do Siconfi vem em reais (é o valor declarado na DCA); o restante do diagnóstico (crédito recuperável, candidatos) vem em centavos. A conversão é feita na borda, nunca no meio do cálculo.', { s: 8.4, c: C.muted });

  // ------------------------------------------------------------------ 3. diagnóstico fiscal
  secao('Diagnóstico Fiscal');
  par('O diagnóstico fiscal parte do que o município efetivamente reteve e do que pagou a terceiros, confrontado com a alíquota que a lei impõe sobre esses serviços. A diferença é o ponto de partida — não a conclusão: nem toda compra de serviço gera IRRF na mesma alíquota, e a base da DCA não separa os itens por alíquota.');
  doc.moveDown(0.6);
  const ALIQ = 0.015;
  const serieComTeto = serie.map((l) => {
    const base = l.despesas.baseServicosIrrf || 0;
    const obs = l.irrf.outros || 0;
    return { l, base, obs, taxa: l.taxaObservadaIrrf, esperado: base * ALIQ, teto: Math.max(0, base * ALIQ - obs) };
  });
  const tot = serieComTeto.reduce((s, x) => ({ base: s.base + x.base, obs: s.obs + x.obs, esperado: s.esperado + x.esperado, teto: s.teto + x.teto }), { base: 0, obs: 0, esperado: 0, teto: 0 });
  subtitulo('Série do Siconfi (Tesouro Nacional) — base: despesas com serviços a PJ, coluna "Despesas Pagas"');
  const cf = ['Ano', 'IRRF sobre serviços', 'Base: serviços PJ (pagos)', 'Taxa observada', 'Esperado a 1,5%', 'Defasagem (teto)'];
  const cw3 = [40, 95, 115, 75, 95, 100];
  y = doc.y;
  let cx3 = M;
  doc.font('S').fontSize(7).fillColor(C.muted);
  cf.forEach((c, i) => { doc.text(c.toUpperCase(), cx3, y, { width: cw3[i], align: i ? 'right' : 'left', characterSpacing: 0.4, lineBreak: false }); cx3 += cw3[i]; });
  doc.y = y + 13; regua(doc.y, C.tinta, 0.6);
  for (const x of serieComTeto) {
    espaco(20); y = doc.y + 6;
    cx3 = M;
    const vals = [String(x.l.ano), num(x.obs), num(x.base), pct(x.taxa, 4), num(x.esperado), num(x.teto)];
    vals.forEach((v, i) => {
      doc.font(i === 0 ? 'M' : 'R').fontSize(8.4).fillColor(i === 0 ? C.tinta : C.texto)
        .text(v, cx3, y, { width: cw3[i], align: i ? 'right' : 'left', lineBreak: false });
      cx3 += cw3[i];
    });
    doc.y = y + 15; regua(doc.y);
  }
  y = doc.y + 7; cx3 = M;
  const totais = ['5 anos', num(tot.obs), num(tot.base), pct(tot.base ? tot.obs / tot.base : null, 4), num(tot.esperado), num(tot.teto)];
  totais.forEach((v, i) => {
    doc.font('S').fontSize(8.4).fillColor(C.tinta).text(v, cx3, y, { width: cw3[i], align: i ? 'right' : 'left', lineBreak: false });
    cx3 += cw3[i];
  });
  doc.y = y + 16; regua(doc.y, C.tinta, 0.6);
  doc.moveDown(0.8);
  par('A base é a coluna "Despesas Pagas" do Anexo I-D: a retenção de IRRF nasce do pagamento. A coluna "Despesas Empenhadas" — o compromisso — inflaria a base em cerca de 6% e afundaria a taxa observada. Já a taxa observada é calculada sobre o IRRF de serviços, nunca sobre o IRRF total, que inclui a folha.', { s: 8.4, c: C.muted });
  doc.moveDown(0.8);

  subtitulo('ISSQN — a base recalculada, e o que ela revela');
  par('A DCA traz o ISSQN arrecadado, não a base de cálculo. A base é reconstruída por dois caminhos independentes: o bracket pelas alíquotas do CTM (art. 266: 2% a 5%) e a prova de composição contra o PNCP.');
  doc.moveDown(0.4);
  y = doc.y;
  const ci = ['Ano', 'ISSQN arrecadado', 'Base implícita (a 5%)', 'Base implícita (a 2%)'];
  const cw4 = [45, 115, 145, 70];
  let cx4 = M;
  doc.font('S').fontSize(7).fillColor(C.muted);
  ci.forEach((c, i) => { doc.text(c.toUpperCase(), cx4, y, { width: cw4[i], align: i ? 'right' : 'left', characterSpacing: 0.4, lineBreak: false }); cx4 += cw4[i]; });
  doc.y = y + 13; regua(doc.y, C.tinta, 0.6);
  for (const l of serie) {
    espaco(20); y = doc.y + 6;
    cx4 = M;
    const a = String(l.ano);
    const vals = [String(l.ano), num(l.issqn.arrecadado), num((ISSQN_RECALC.baseImplicitaMin5pct || {})[a] || 0), num((ISSQN_RECALC.baseImplicitaMax2pct || {})[a] || 0)];
    vals.forEach((v, i) => {
      doc.font(i === 0 ? 'M' : 'R').fontSize(8.4).fillColor(i === 0 ? C.tinta : C.texto)
        .text(v, cx4, y, { width: cw4[i], align: i ? 'right' : 'left', lineBreak: false });
      cx4 += cw4[i];
    });
    doc.y = y + 15; regua(doc.y);
  }
  doc.moveDown(0.5);
  par('Prova de composição — o ISSQN vem da economia privada, não do consumo do próprio município:', { s: 8.6, c: C.tinta });
  y = doc.y;
  const cpn = ['Ano', 'Piso de serviços contratados (PNCP)', 'Contratos', 'ISSQN arrecadado', 'ISSQN / piso'];
  const cwp = [40, 150, 65, 100, 70];
  let cxpP = M;
  doc.font('S').fontSize(7).fillColor(C.muted);
  cpn.forEach((c, i) => { doc.text(c.toUpperCase(), cxpP, y, { width: cwp[i], align: i ? 'right' : 'left', characterSpacing: 0.4, lineBreak: false }); cxpP += cwp[i]; });
  doc.y = y + 13; regua(doc.y, C.tinta, 0.6);
  for (const ano of ['2024', '2025']) {
    espaco(20); y = doc.y + 6;
    cxpP = M;
    const piso = (PNCP_PISO[ano] && PNCP_PISO[ano].pisoBaseServicos) || 0;
    const nc = (PNCP_PISO[ano] && PNCP_PISO[ano].contratos && PNCP_PISO[ano].contratos.length) || 0;
    const iss = (ISSQN_RECALC.issqnDeclarado || {})[ano] || 0;
    const vals = [ano, num(piso), String(nc), num(iss), pct(piso ? iss / piso : null, 1)];
    vals.forEach((v, i) => {
      doc.font(i === 0 ? 'M' : 'R').fontSize(8.4).fillColor(i === 0 ? C.tinta : C.texto)
        .text(v, cxpP, y, { width: cwp[i], align: i ? 'right' : 'left', lineBreak: false });
      cxpP += cwp[i];
    });
    doc.y = y + 15; regua(doc.y);
  }
  doc.moveDown(0.6);
  par('O município contratou R$ 2.988.820,20 em serviços em 2024 (9 contratos) e R$ 6.003.475,86 em 2025 (31 contratos) — esse é o piso de serviço adquirido pelo próprio ente. O ISSQN arrecadado é 323,3% desse piso em 2024 e 142,3% em 2025: o imposto incide, majoritariamente, sobre serviços prestados por empresas privadas à população (em 2025, no mínimo cerca de 96% da base mínima).', { s: 8.4, c: C.texto });
  doc.moveDown(0.3);
  par('Consequência: a base do ISSQN não está no dado público — nem na DCA, nem no PNCP — e a fonte decisiva é a NFS-e emitida. O ISSQN permanece "a dimensionar": o que existe aqui é um bracket sourced (base implícita de R$ 67,8 mi a R$ 483,2 mi por ano) e a composição demonstrada, não uma base apurada. A "Receita de serviços" da DCA (1.6) é a receita do próprio município, não a base do ISSQN: usá-la como denominador produzia razão acima de 100% (135,8% em 2024 e 102,4% em 2025) — artefato de leitura, não anomalia. Ressalvas: a separação do PNCP foi por filtro de texto e capturou itens não tributáveis (locação de cilindros de oxigênio, locação de imóvel — LC 116, item 3.03); e 2021–2023 estão vazios porque a publicação obrigatória começou em abril de 2024 (Lei 14.133/2021) — ausência legítima, não dado faltante. Base legal: CTM de Tupaciguara, art. 77 (base = preço do serviço) e art. 266 (2% a 5%).', { s: 8.4, c: C.texto });

  // ------------------------------------------------------------------ 4. diagnóstico previdenciário
  secao('Diagnóstico Previdenciário');
  par('A análise previdenciária parte da folha de pagamento real, publicada pelo próprio município. A contagem de competências é o ponto de partida: o 13º salário é apuração anual no eSocial (indApuracao=2), e não se confunde com a competência de dezembro.');
  doc.moveDown(0.6);
  const n13 = anos.reduce((s, a) => s + a.n13, 0);
  const nTot = [...porComp.values()].length;
  par(`A folha publicada traz ${nTot} competências mensais e ${inteiro(n13)} lançamentos de 13º (rotinas P13/A13) ao longo de ${anos.length} anos — ${nTot + anos.length} competências de apuração.`, { s: 9.2, c: C.muted });
  doc.moveDown(0.8);
  subtitulo('Folha por ano');
  const ay = { ano: M, comps: M + 50, bruto: M + 100, base: M + 210, desc: M + 320, taxa: M + LW - 70 };
  y = doc.y;
  doc.font('S').fontSize(7.5).fillColor(C.muted);
  [['ANO', ay.ano], ['COMPETÊNCIAS', ay.comps], ['BRUTO', ay.bruto], ['SALÁRIO-BASE', ay.base], ['DESCONTOS', ay.desc], ['DESC./BRUTO', ay.taxa]]
    .forEach(([c, x]) => doc.text(c, x, y, { width: 100, align: x > ay.ano ? 'right' : 'left', characterSpacing: 0.5, lineBreak: false }));
  doc.y = y + 13; regua(doc.y, C.tinta, 0.6);
  const soma = (f) => anos.reduce((s, a) => s + f(a), 0);
  const nCompsTotais = anos.reduce((s2, a) => s2 + a.comps.size, 0);
  const linhasAno = [...anos, { ano: 'Total', compsTotais: nCompsTotais, bruto: soma((a) => a.bruto), base: soma((a) => a.base), desc: soma((a) => a.desc) }];
  linhasAno.forEach((a, i) => {
    espaco(20); y = doc.y + 6;
    const forte = i === linhasAno.length - 1;
    const vals = [a.ano, String(a.comps ? a.comps.size : a.compsTotais), num(a.bruto), num(a.base), num(a.desc), pct(a.bruto ? a.desc / a.bruto : null)];
    const xs = [ay.ano, ay.comps, ay.bruto, ay.base, ay.desc, ay.taxa];
    vals.forEach((v, j) => {
      doc.font(forte ? 'S' : 'R').fontSize(8.8).fillColor(forte ? C.tinta : C.texto)
        .text(v, xs[j], y, { width: 100, align: j ? 'right' : 'left', lineBreak: false });
    });
    doc.y = y + 15; regua(doc.y, forte ? C.tinta : C.linha, forte ? 0.6 : 0.5);
  });
  doc.moveDown(0.9);
  subtitulo('Sinais de triagem — o que o dado público mostra e o que ele não permite afirmar');
  const sinais = [
    ['13º é competência própria', 'No eSocial, o 13º é apuração anual (indApuracao=2, perApur=AAAA): é um lançamento distinto, não o mesmo de dezembro. O motor do Reversa trata essa apuração como competência própria (AAAA-MM/13), sem fundir em dezembro.'],
    ['Desconto no 13º menor que na folha', 'O 13º apresenta taxa efetiva de desconto inferior à da folha mensal do mesmo servidor. Sinal de que a rubrica do 13º não recebe o mesmo tratamento. NÃO é dívida apurada: o total de descontos mistura INSS, IRRF e consignações, e a folha pública não traz as rubricas.'],
    ['Adiantamento sem desconto', 'A rotina A13 (adiantamento do 13º) aparece com desconto praticamente zero. Pode ser o mecanismo correto — a retenção do 13º se concentra no pagamento final — ou pode ser ausência de recolhimento. A confirmação exige o eSocial (S-1200/S-1300).'],
    ['IRRF e INSS da folha', 'A DCA declara o IRRF retido sobre o trabalho, e a folha traz a base. A conferência item a item exige as rubricas por evento: com elas, o IRRF due é calculável pela tabela oficial e confrontável com o declarado.']
  ];
  sinais.forEach(([rot, txt]) => {
    espaco(40);
    doc.font('S').fontSize(8.6).fillColor(C.tinta).text(rot, M, doc.y, { width: LW });
    doc.y += 11;
    doc.font('R').fontSize(8.4).fillColor(C.texto).text(txt, M, doc.y, { width: LW, lineGap: 1.9 });
    doc.y += doc.heightOfString(txt, { width: LW, lineGap: 1.9 }) + 7;
  });

  // ------------------------------------------------------------------ 4b. oportunidades previdenciárias e IRRF
  secao('Oportunidades previdenciárias e de IRRF');
  par('Duas perguntas, respondidas com cálculo. (1) A folha recebeu o tratamento legal do 13º? (2) O IRRF retido está coerente com a base legal? A resposta da folha vem do próprio portal do município, competência a competência; a resposta do IRRF vem do confronto entre a DCA e a tabela oficial.');
  doc.moveDown(0.7);
  const prev = require('./calcular-previdenciario-resultado.json');
  subtitulo('13º salário — a contribuição que não foi recolhida');
  par('Lei 8.212/1991, art. 28, §7º: o décimo terceiro salário integra o salário-de-contribuição. O piso de cada lançamento é a contribuição previdenciária (progressiva do empregado, com o teto do salário-de-contribuição do ano) mais o IRRF do 13º pela tabela mensal. Se o desconto observado ficar abaixo do piso, a conclusão é firme: o lançamento não recebeu o tratamento legal — IRRF e consignações, se existissem, apenas somariam ao desconto observado.');
  doc.moveDown(0.6);
  const cp = [52, 82, 78, 92, 78, 78];
  const cph = ['Verba', 'Grupos', 'Bruto', 'Desconto', 'Taxa', 'Abaixo do piso'];
  y = doc.y;
  let cxp = M;
  doc.font('S').fontSize(7).fillColor(C.muted);
  cph.forEach((c, i) => { doc.text(c.toUpperCase(), cxp, y, { width: cp[i], align: i ? 'right' : 'left', characterSpacing: 0.4, lineBreak: false }); cxp += cp[i]; });
  doc.y = y + 13; regua(doc.y, C.tinta, 0.6);
  for (const v of prev.verbas) {
    espaco(20); y = doc.y + 6;
    cxp = M;
    const vals = [v.rotina, String(v.grupos), num(v.bruto), num(v.desconto), pct(v.taxaDesconto, 2), String(v.abaixoPiso)];
    vals.forEach((val, i) => {
      doc.font(i === 0 ? 'M' : 'R').fontSize(8.4).fillColor(i === 0 ? C.tinta : (i === 5 && v.abaixoPiso ? C.ouro : C.texto))
        .text(val, cxp, y, { width: cp[i], align: i ? 'right' : 'left', lineBreak: false });
      cxp += cp[i];
    });
    doc.y = y + 15; regua(doc.y);
  }
  y = doc.y + 7; cxp = M;
  const totp = ['Total', String(prev.total.grupos), num(prev.total.bruto), num(prev.total.desconto), pct(prev.total.desconto / prev.total.bruto, 2), String(prev.total.abaixoPiso)];
  totp.forEach((val, i) => {
    doc.font('S').fontSize(8.4).fillColor(C.tinta).text(val, cxp, y, { width: cp[i], align: i ? 'right' : 'left', lineBreak: false });
    cxp += cp[i];
  });
  doc.y = y + 16; regua(doc.y, C.tinta, 0.6);
  doc.moveDown(0.6);
  par('Teste por servidor-mês (RIR/2018 art. 677, §2º: a alíquota incide sobre a soma dos rendimentos pagos no mês) e, no 13º, por pacote (adiantamento + parcela final, porque o adiantamento é compensado no pagamento final). FOL = folha mensal · FER = férias · FCO = folha complementar · DES = desligamento · P13 = 13º (pacote) · A13 = adiantamento do 13º sem parcela final correspondente.', { s: 7.8, c: C.muted });
  doc.moveDown(0.6);
  y = doc.y;
  doc.rect(M, y, LW, 68).fill(C.fundo);
  doc.rect(M, y, 3, 68).fill(C.ouro);
  doc.font('S').fontSize(8).fillColor(C.muted).text('CONTRIBUIÇÃO PREVIDENCIÁRIA NÃO RECOLHIDA — FOLHA (5 ANOS)', M + 16, y + 11, { characterSpacing: 0.8, lineBreak: false });
  doc.font('B').fontSize(19).fillColor(C.tinta).text(`${reais(prev.total.faltaPiso)}  a  ${reais(prev.total.faltaTeto)}`, M + 16, y + 24, { lineBreak: false });
  doc.font('R').fontSize(8.4).fillColor(C.texto).text(`piso: 7,5% da base + IRRF da verba (faixa provada)   ·   teto: 14% + IRRF   ·   ${prev.total.abaixoPiso} grupos de servidor-mês abaixo do piso`, M + 16, y + 51, { lineBreak: false });
  doc.y = y + 78;
  doc.moveDown(0.4);
  par(`O caso mais grave é o desligamento: ${prev.verbas.find((v) => v.rotina === 'DES').abaixoPiso} de ${prev.verbas.find((v) => v.rotina === 'DES').grupos} desligamentos abaixo do piso, com taxa efetiva de desconto de ${pct(prev.verbas.find((v) => v.rotina === 'DES').taxaDesconto, 2)} contra ${pct(prev.verbas.find((v) => v.rotina === 'FOL').taxaDesconto, 2)} da folha mensal. São ${prev.total.descontoZerado} grupos sem nenhum desconto. Impacto: o RGPS/INSS não recebeu a contribuição e o servidor não tem o tempo de contribuição. O regime de Tupaciguara é o RGPS, não RPPS próprio — a DCA registra a despesa patronal sob o rótulo "Contribuições Previdenciárias - INSS" (3.1.90.13.02) e o CadPrev confirma o enquadramento em RGPS; por isso a ausência de demonstrativos próprios de RPPS é inaplicabilidade, não dado faltante. A confirmação item a item exige o eSocial (S-1200/S-1300).`, { s: 8.4, c: C.texto });
  doc.moveDown(0.8);

  subtitulo('IRRF sobre a folha — o retido está coerente com a base legal');
  par('Método: base = bruto da remuneração menos o desconto simplificado mensal (25% do limite da faixa de alíquota zero, que a fonte pagadora deve considerar quando mais favorável), aplicada à soma dos rendimentos do servidor no mês (RIR/2018 art. 677, §2º). O 13º é tributado em separado (art. 677, §3º).');
  doc.moveDown(0.6);
  const ci2 = ['Ano', 'IRRF no cenário desconto simplificado', 'IRRF declarado na DCA', 'Diferença', 'Demais descontos da folha'];
  const cw5 = [42, 130, 110, 95, 110];
  espaco(120);
  y = doc.y;
  let cxq = M;
  doc.font('S').fontSize(7).fillColor(C.muted);
  ci2.forEach((c, i) => { doc.text(c.toUpperCase(), cxq, y, { width: cw5[i], align: i ? 'right' : 'left', characterSpacing: 0.4, lineBreak: false }); cxq += cw5[i]; });
  doc.y = y + 13; regua(doc.y, C.tinta, 0.6);
  for (const l of prev.irrf) {
    espaco(20); y = doc.y + 6;
    cxq = M;
    const vals = [String(l.ano), num(l.cenario), num(l.declarado), num(l.diferenca), num(l.outros)];
    vals.forEach((v, i) => {
      doc.font(i === 0 ? 'M' : 'R').fontSize(8.4).fillColor(i === 0 ? C.tinta : C.texto)
        .text(v, cxq, y, { width: cw5[i], align: i ? 'right' : 'left', lineBreak: false });
      cxq += cw5[i];
    });
    doc.y = y + 15; regua(doc.y);
  }
  y = doc.y + 7; cxq = M;
  const totIrrf = ['5 anos', num(prev.totais.cenario), num(prev.totais.declarado), num(prev.totais.declarado - prev.totais.cenario), num(prev.totais.outros)];
  totIrrf.forEach((val, i) => {
    doc.font('S').fontSize(8.4).fillColor(C.tinta).text(val, cxq, y, { width: cw5[i], align: i ? 'right' : 'left', lineBreak: false });
    cxq += cw5[i];
  });
  doc.y = y + 16; regua(doc.y, C.tinta, 0.6);
  doc.moveDown(0.6);
  par('O IRRF declarado fica acima do cenário do desconto simplificado e abaixo dos demais descontos da folha (INSS, IR e consignações). Essa é a ordem que a lei espera: a base real do IRRF é o bruto menos as deduções legais (INSS e dependentes), maiores que o desconto simplificado. Não há indício de retenção a menor do que a devida — o que ainda precisa de prova é o contrário: a conferência rubrica a rubrica, que o eSocial entrega.', { s: 8.4, c: C.texto });
  doc.moveDown(1);

  subtitulo('Obrigações patronais — INSS/RGPS: o passivo de 2024–2025');
  par('Método: a DCA do município registra a despesa patronal em 3.1.90.13.02, com o rótulo do próprio Tesouro — "Contribuições Previdenciárias - INSS". O piso legal adotado é a cota patronal de 20% (Lei 8.212/1991, art. 22, III, "a") sobre a despesa de pessoal registrada (3.1.90.11 vencimentos + 3.1.90.04 contratação por tempo determinado). RAT e terceiros (0,3% a 4,8%) ficam de fora, de propósito: o piso é o mais conservador possível.');
  doc.moveDown(0.4);
  y = doc.y;
  const cpPat = ['Ano', 'Despesa de pessoal (DCA)', 'Patronal pago (DCA)', 'Razão', 'Piso legal 20%', 'Diferença'];
  const cwpPat = [38, 112, 100, 52, 100, 83];
  let cxpPat = M;
  doc.font('S').fontSize(7).fillColor(C.muted);
  cpPat.forEach((c, i) => { doc.text(c.toUpperCase(), cxpPat, y, { width: cwpPat[i], align: i ? 'right' : 'left', characterSpacing: 0.4, lineBreak: false }); cxpPat += cwpPat[i]; });
  doc.y = y + 13; regua(doc.y, C.tinta, 0.6);
  for (const x of patronal) {
    espaco(20); y = doc.y + 6;
    cxpPat = M;
    const vals = [x.ano, num(x.massa), num(x.patronal), pct(x.razao, 2), num(x.piso20), (x.diferenca > 0 ? '− ' : '+ ') + num(Math.abs(x.diferenca))];
    vals.forEach((v, i) => {
      const forte = i === 5 && x.diferenca > 0;
      doc.font(forte ? 'M' : (i === 0 ? 'M' : 'R')).fontSize(8.4).fillColor(forte ? C.tinta : (i === 0 ? C.tinta : C.texto))
        .text(v, cxpPat, y, { width: cwpPat[i], align: i ? 'right' : 'left', lineBreak: false });
      cxpPat += cwpPat[i];
    });
    doc.y = y + 15; regua(doc.y);
  }
  doc.moveDown(0.5);
  par('A leitura, em quatro passos. (1) O método se valida no próprio dado do município: em 2021–2023 a despesa patronal fica entre 19,05% e 23,71% da despesa de pessoal — em torno do piso de 20% que o método aplica, com desvios de −4,78%, −1,42% e +10,67%. O mesmo método não acusaria nada onde não há o que acusar. (2) 2024 e 2025 quebram a série — 9,88% e 12,72% — enquanto a despesa de pessoal cresce de R$ 56,99 mi (2023) para R$ 65,03 mi (2024) e R$ 71,22 mi (2025): a diferença para o piso legal é de R$ 6.579.673,01 (−50,59%) e R$ 5.184.863,97 (−36,41%). (3) Não é atraso de pagamento: o empenhado também cai (R$ 6.930.863,03 em 2024) e os restos a pagar são pequenos e integralmente pagos no ano seguinte (inscrição de R$ 87.346,63 no fim de 2025). O que falta é o recolhimento, não o registro contábil. (4) O passivo de 2024–2025 soma R$ 11.764.536,98 no piso de 20%.', { s: 8.4, c: C.texto });
  doc.moveDown(0.3);
  par('Natureza: é passivo do município com o regime (INSS) — contribuição patronal devida e não recolhida. Cresce a exposição; não é receita do município nem crédito a receber pelo ente. Para o servidor, o efeito é a perda do tempo de contribuição. Não soma com a faixa de contribuição retida e não repassada (R$ 388.457,61 a R$ 501.068,68): naturezas, beneficiários e provas diferentes, e somá-los criaria um número artificial. E não é crédito reconhecido (CPC 25): é cálculo do diagnóstico sobre dado público. O gap de 2025 sozinho, no piso conservador de 20%, é R$ 5.184.863,97 — a mesma ordem de grandeza da expectativa de R$ 5 milhões, agora com método, fonte e base legal. Para converter estimativa em apuração: eSocial (S-1200/S-1300), DCTFWeb/DARF do INSS e o CRP no CadPrev.', { s: 8.4, c: C.texto });

  // ------------------------------------------------------------------ 5. diagnóstico consolidado
  secao('Diagnóstico Consolidado');
  par('Três grandezas diferentes, e é importante não confundi-las. (1) O cálculo do diagnóstico é uma estimativa sobre dado público, com teto. (2) A apuração do motor é o que a prova documental permite calcular candidato a candidato. (3) O crédito reconhecido é um conceito contábil (CPC 25): só existe quando a realização é praticamente certa, e nesta fase ele não é apurável. Um zero na linha 2 significa "nenhum documento de retenção foi fornecido" — não "não há crédito a recuperar".');
  doc.moveDown(1);
  const mx = [M, M + LW - 300, M + LW - 200, M + LW - 100], mw = 100;
  const celula = (t, i, yy, f = 'R', cor = C.texto) => doc.font(f).fontSize(9.2).fillColor(cor).text(t, i ? mx[i] : mx[0], yy, { width: i ? mw : 200, align: i ? 'right' : 'left', lineBreak: false });
  y = doc.y;
  doc.font('S').fontSize(7.5).fillColor(C.muted);
  ['INDICADOR', 'PROVÁVEL', 'POSSÍVEL', 'TOTAL'].forEach((t, i) => doc.text(t, i ? mx[i] : mx[0], y, { width: i ? mw : 200, align: i ? 'right' : 'left', characterSpacing: 0.6, lineBreak: false }));
  doc.y = y + 14; regua(doc.y, C.tinta, 0.6);
  const linhasCons = [
    ['Oportunidades fiscais identificadas', 0, 1, 1],
    ['Oportunidades previdenciárias identificadas', 0, 1, 1],
    ['Candidatos com evidência suficiente (documento de retenção)', 0, 0, 0]
  ];
  linhasCons.forEach(([rot, v, a, t]) => {
    y = doc.y + 8;
    celula(rot, 0, y); celula(String(v), 1, y); celula(String(a), 2, y); celula(String(t), 3, y, 'M');
    doc.y = y + 19; regua(doc.y);
  });
  y = doc.y + 8;
  celula('Cálculo do diagnóstico sobre dado público — teto (R$)', 0, y, 'S', C.tinta);
  celula('—', 1, y); celula('—', 2, y);
  celula(num((rec.totalCents || 0) / 100), 3, y, 'S', C.tinta);
  doc.y = y + 19; regua(doc.y, C.tinta, 0.6);
  y = doc.y + 8;
  celula('Apuração do motor sobre documentos — candidato apurado (R$)', 0, y, 'S', C.tinta);
  celula('—', 1, y); celula('—', 2, y);
  celula(num((diag.creditoRecuperavelCents || 0) / 100), 3, y, 'S', C.tinta);
  doc.y = y + 19; regua(doc.y, C.tinta, 0.6);
  y = doc.y + 8;
  celula('Passivo patronal estimado — INSS/RGPS 2024–2025 (R$)', 0, y, 'S', C.tinta);
  celula('—', 1, y); celula('—', 2, y);
  celula(num(gap2425Total), 3, y, 'S', C.tinta);
  doc.y = y + 19; regua(doc.y);
  y = doc.y + 8;
  celula('Contribuição retida e não repassada — folha 5 anos (R$)', 0, y, 'S', C.tinta);
  celula('—', 1, y); celula('—', 2, y);
  celula(num((prev.total.faltaPiso || 0)) + ' – ' + num((prev.total.faltaTeto || 0)), 3, y, 'S', C.tinta);
  doc.y = y + 19; regua(doc.y, C.tinta, 0.6);
  y = doc.y + 8;
  celula('Crédito reconhecido (CPC 25)', 0, y, 'S', C.tinta);
  celula('—', 1, y); celula('—', 2, y);
  celula('não apurável', 3, y, 'S', C.tinta);
  doc.y = y + 19; regua(doc.y, C.tinta, 0.6);
  doc.moveDown(0.5);
  par('O passivo patronal e a faixa de contribuição retida aparecem em linhas próprias porque são grandezas de naturezas diferentes — um é o que o município deve ao regime, o outro é o que o servidor tem direito e o município não repassou. Somar os dois, ou somá-los ao IRRF sobre serviços, criaria um número artificial. A coluna "crédito reconhecido" continua vazia de propósito: reconhecimento exige prova documental e revisão humana.', { s: 8.4, c: C.muted });
  doc.moveDown(0.8);

  subtitulo('Próximos passos');
  const passos = [
    'Receber a EFD-Reinf (ou a planilha de pagamentos) do município, com retenção por serviço, base declarada e alíquota — é o que transforma o teto em valor apurado.',
    'Obter o eSocial da folha (S-1000, S-1005, S-1010, S-1200 e S-1300) para conferir rubrica e base competência a competência, incluindo o 13º como apuração própria, e fechar o sinal do desconto menor no 13º.',
    'Coletar as NFS-e emitidas no município (valor dos serviços) e o CTM vigente (Tabela I de alíquotas) para reconstruir a base do ISSQN — ela não existe no dado público; o bracket e a composição contra o PNCP já estão no relatório.',
    'Obter o DCTFWeb/DARF do INSS e o CRP no CadPrev para converter o passivo patronal de 2024–2025 (R$ 11.764.536,98 no piso legal de 20%) em apuração: o que foi efetivamente recolhido e a posição do regime sobre o ente.',
    'Conferir a ECD e o DARF do período para fechar a conciliação entre o retido e o declarado ao seu mecanismo de compensação.',
    'Apuração definitiva item a item pelo motor Reversa, com memória de cálculo rastreável até o arquivo de origem e atualização pela Selic.',
    'Definição da via de recuperação de cada oportunidade (retificação, PER/DCOMP ou medida judicial), cronograma de compensações e acompanhamento com relatórios periódicos.'
  ];
  passos.forEach((p, i) => {
    espaco(30); y = doc.y + 4;
    doc.font('T').fontSize(12).fillColor(C.esmeralda).text(String(i + 1).padStart(2, '0'), M, y - 1, { lineBreak: false });
    doc.font('R').fontSize(9.3).fillColor(C.texto).text(p, M + 30, y, { width: LW - 30, lineGap: 2.4 });
    doc.y += 6;
  });
  doc.moveDown(0.6);
  par('Fontes indisponíveis permanecem registradas como indisponíveis: o Tribunal de Contas do Estado de Minas Gerais (CAPMG) não respondeu ao ambiente de coleta (egress bloqueado e cota de CAPTCHA), e a consulta pública do CadPrev também. Isso não zera o dado: apenas o marca como faltante. As demais fontes responderam: PNCP (329 contratos de 2024 a 2026, com verificação item a item pendente), TCU (2 registros no processo 034.869/2016-6), Siconfi/DCA (5 exercícios), portal de transparência (folha de 65 competências) e a base oficial de estatísticas do RPPS.', { s: 8.6, c: C.muted });

  // ------------------------------------------------------------------ 6. apuração pelo motor
  secao('Apuração pelo motor Reversa');
  const candidatos = diag.candidatos || [];
  if (candidatos.length) {
    par('Candidatos gerados na apuração sobre os pagamentos analisados. A coluna de revisão mostra o estágio da prova; a coluna de valor mostra o que o motor apurou — e o motor não reconhece crédito sem a evidência correspondente.', { s: 9, c: C.muted });
    doc.moveDown(0.8);
    y = doc.y;
    doc.font('S').fontSize(7.5).fillColor(C.muted);
    doc.text('CANDIDATO', M, y, { characterSpacing: 0.6 });
    doc.text('REGRA', M + 190, y, { characterSpacing: 0.6 });
    doc.text('REVISÃO', M + 320, y, { characterSpacing: 0.6 });
    doc.text('NO PRAZO (R$)', M + 390, y, { width: LW - 390, align: 'right', characterSpacing: 0.6 });
    doc.y = y + 13; regua(doc.y, C.tinta, 0.6);
    candidatos.forEach((c) => {
      espaco(24); y = doc.y + 6;
      doc.font('M').fontSize(9).fillColor(C.texto).text(c.fornecedor || '—', M, y, { width: 180, lineBreak: false, ellipsis: true });
      doc.font('R').fontSize(8.6).fillColor(C.muted).text(c.rule || '—', M + 190, y, { lineBreak: false });
      doc.text(c.status === 'CONFIRMADO' ? 'Aprovada' : 'Pendente', M + 320, y, { lineBreak: false });
      doc.font('M').fontSize(9).fillColor(C.tinta).text(num((c.creditoRetroativoCents || 0) / 100), M + 390, y, { width: LW - 390, align: 'right' });
      doc.y = y + 15; regua(doc.y);
    });
  } else {
    par('Nenhum candidato foi apurado — e o motivo é o dado, não a ausência de análise. O motor trabalha por PAGAMENTO: ele lê os documentos de retenção (EFD-Reinf, planilha, relatório de pagamentos) e compara o que foi retido com o que deveria ter sido. Nenhum desses documentos foi fornecido para este município.', { s: 9.2 });
    doc.moveDown(0.8);
    y = doc.y;
    doc.rect(M, y, LW, 96).fill(C.fundo);
    doc.rect(M, y, 3, 96).fill(C.ouro);
    doc.font('S').fontSize(8).fillColor(C.muted).text('ESTADO DA PROVA', M + 16, y + 12, { characterSpacing: 0.8, lineBreak: false });
    doc.font('R').fontSize(9).fillColor(C.texto).text(
      'Documentos no processo: 5 (as DCAs do Siconfi, 2021 a 2025) — documentos públicos de-contextualização do município.\n' +
      'Documentos de retenção (EFD-Reinf / planilha / relatório de pagamentos): nenhum.\n' +
      'Candidatos apurados: 0. Valor apurado: R$ 0,00 — porque o documento de retenção não foi fornecido, e não porque o valor seja zero.\nCrédito reconhecido (CPC 25): nada, e nada foi descartado — o reconhecimento exige conferência humana e documento autorizado.',
      M + 16, y + 28, { width: LW - 32, lineGap: 2.6 });
    doc.y = y + 106;
    doc.moveDown(0.6);
    par('O que a apuração já produziu sem documento do município: o cálculo preliminar do total recuperável (seção 02), a série de cinco anos do Siconfi, a folha de pagamento real e o inventário do que falta. Quando a EFD-Reinf chegar, o motor roda de novo sobre ela sem refazer nada disto.', { s: 8.6, c: C.texto });
  }

  // ------------------------------------------------------------------ 7. anexo
  secao('Anexo — memória de cálculo, proveniência e ressalvas');
  const campo = (rot, txt) => {
    if (!txt || txt === '—') return;
    doc.font('R').fontSize(8.6);
    espaco(doc.heightOfString(txt, { width: LW - 92, lineGap: 1.8 }) + 8);
    const yy = doc.y + 3;
    doc.font('S').fontSize(6.8).fillColor(C.claro).text(rot.toUpperCase(), M, yy + 1.2, { width: 84, characterSpacing: 0.6 });
    doc.font('R').fontSize(8.6).fillColor(C.texto).text(txt, M + 92, yy, { width: LW - 92, lineGap: 1.8 });
  };

  subtitulo('Cálculo, linha a linha');
  const memo = [
    ['Fórmula', 'defasagem = (base de serviços a PJ × 1,5%) − IRRF retido sobre serviços, por ano; o total é a soma dos 5 anos.'],
    ['Base', 'Siconfi DCA, Anexo I-D, coluna "Despesas Pagas": 3.3.90.39 (outros serviços de terceiros — PJ) + 3.3.90.35 (consultoria) + 3.3.90.40 (TI e comunicação).'],
    ['Observado', 'Siconfi DCA, Anexo I-C, coluna "Receitas Brutas Realizadas", linha RO1.1.1.3.03.4.0 — IRRF retido na fonte, outros rendimentos (a natureza que corresponde aos pagamentos a prestadores).'],
    ['Fator legal', '1,5% — Lei 9.249/1995, art. 30, II, "a"; IN RFB 1.234/2012, art. 30, I. Itens específicos têm alíquota maior (3% no transporte, 4,5% em medicina, engenharia e advocacia, 6% em consultoria e assessment), e há isenções.'],
    ['Por que é teto', 'A base da DCA não separa os itens por alíquota e não exclui os isentos. O valor apurado será igual ou menor que o teto. Por isso o número aparece como teto, e não como crédito.'],
    ['Por que a coluna "Pagas"', 'A retenção de IRRF nasce do pagamento. A coluna "Despesas Empenhadas" (o compromisso) é maior em cerca de 6% e afundaria a taxa observada — o número de uma edição anterior deste relatório.'],
    ['ISSQN', 'A DCA traz o imposto arrecadado, não a base de cálculo. A base foi reconstruída por bracket (alíquotas do CTM: 2% a 5%) e a composição foi provada contra o PNCP: o ISSQN arrecadado é 323,3% (2024) e 142,3% (2025) de tudo o que o município contratou de terceiros — ou seja, no mínimo cerca de 96% da base mínima vem da economia privada. A defasagem não é calculável com dado público; a fonte decisiva é a NFS-e emitida. Base legal: CTM de Tupaciguara, art. 77 (base = preço do serviço) e art. 266 (alíquota mínima 2%, máxima 5%).'],
    ['Patronal (INSS/RGPS)', 'O passivo patronal de 2024–2025 é calculado sobre a despesa de pessoal registrada na DCA (3.1.90.11 + 3.1.90.04), com piso legal de 20% (Lei 8.212/1991, art. 22, III, "a"). O denominador é um proxy da base legal — o eSocial entrega a base real. A linha da DCA é registro contábil de despesa, não prova de recolhimento: a confirmação vem do DARF/DCTFWeb e do CRP no CadPrev. RAT e terceiros (0,3% a 4,8%) ficaram fora do piso, para mantê-lo conservador.']
  ];
  memo.forEach(([r2, txt]) => { campo(r2, txt); doc.y += 3; });

  subtitulo('Proveniência das fontes');
  const fontes = [
    ['Siconfi — DCA', `Tesouro Nacional, API de dados abertos, ente ${diag.ibgeCode} (${municipio}/${uf}), exercícios ${serie.map((l) => l.ano).join(', ')}. Anexo I-C (receitas) e Anexo I-D (despesas).`],
    ['Portal do município', 'Transparência municipal, folha de pagamento publicada: competências mensais e lançamentos de 13º, agregados por competência. Sem dado pessoal.'],
    ['CTM de Tupaciguara', 'Código Tributário Municipal (site da Prefeitura): art. 77 (base do ISSQN), art. 78 (desconto na fonte) e art. 266 (alíquotas de 2% a 5%, Tabela I).'],
    ['Motor Reversa', 'Apuração sobre os documentos do processo. Sem documento de retenção, não há candidato: o estado da prova é "sem documento", não "zero".'],
    ['Fontes indisponíveis', 'CAPMG/TCE-MG, CadPrev, PNCP e TCU: sem resposta do ambiente de coleta. Registrado como indisponível.'],
    ['Tabelas de IRRF', 'Planalto: Lei 11.482/2007 (tabelas do art. 1º), Lei 14.848/2024, MP 1.206/2024 e Lei 15.191/2025.']
  ];
  fontes.forEach(([r2, txt]) => { campo(r2, txt); doc.y += 3; });

  subtitulo('Registro de correções e imprecisões encontradas nesta apuração');
  const bugs = [
    ['Dados de amostra no diagnóstico', 'A primeira versão carregou dois candidatos de uma planilha de demonstração (CNPJ fictício 11.222.333/0001-81, competência 2026-05), sem qualquer vínculo com o município. A amostra foi removida do banco e o diagnóstico foi refeito sem ela. Documento de retenção nenhum foi fornecido: o número de candidatos é zero.'],
    ['Coluna errada na base do IRRF', 'A extração da DCA pegava o maior valor entre as colunas da mesma conta — para despesa, isso é "Despesas Empenhadas". A base correta do IRRF retido é "Despesas Pagas". A taxa observada de 2021 a 2025 foi recalculada: 1,0614% · 0,3293% · 1,1914% · 1,4786% · 1,0353%.'],
    ['Fato duplicado na reingestão', 'Consultar o mesmo ano do Siconfi duas vezes duplicava lançamentos e declarações no banco. A ingestão agora apaga o fato do mesmo ano e da mesma fonte antes de gravar o novo.'],
    ['ISSQN de 2021 zerado por código', 'O Treasury mudou o código da conta do ISSQN em 2021 (RO1.1.1.8.02.3.0 → RO1.1.1.4.51.1.0). Buscar só pelo código novo transformava R$ 3.389.396,01 de imposto declarado em zero. A busca passou a casar por rótulo.'],
    ['ISSQN: "Receita de serviços" lida como base', 'A linha 1.6 da DCA é a receita do próprio município, não a base do ISSQN. A razão passou de 100% (135,8% em 2024, 102,4% em 2025) — era artefato de leitura, não anomalia. A base foi reconstruída por bracket pelas alíquotas do CTM e a composição foi provada contra o PNCP.'],
    ['2023 lido como obrigações patronais zeradas', 'O valor de 2023 (R$ 12.614.057,99) migrou da conta 3.1.90.13.02 para 3.1.90.13.99 ("Outras Obrigações Patronais"). É reclassificação contábil, não ausência de pagamento — a leitura anterior tratava o exercício como zerado, e estava errado.'],
    ['Regime do município: RGPS, não RPPS', 'A DCA registra a despesa patronal sob o rótulo "Contribuições Previdenciárias - INSS" (3.1.90.13.02) e o CadPrev registra Tupaciguara em regime RGPS. A ausência de demonstrativos próprios de RPPS é inaplicabilidade, não dado faltante — e a matéria é de INSS/RGPS, não de RPPS.'],
    ['Unidade e casa decimal do DCA', 'Os valores do Siconfi vêm com ponto decimal (ex.: 8544435.46). O parser antigo trocava o ponto por vazio e inflava os números. Corrigido, com teste de regressão sobre o ISSQN de 2025.'],
    ['Unidade da série do Siconfi', 'A série do Siconfi vem em reais e o restante do diagnóstico em centavos. A conversão passou a ficar só na borda, com o nome do campo dizendo a unidade.'],
    ['Folha sem rubricas', 'A folha publicada traz o agregado (bruto, base, desconto), sem a rubrica por evento. Por isso o desconto do 13º mais baixo que o da folha é sinal de triagem, e não dívida apurada.'],
    ['Valor não reconhecido', 'Nenhum valor deste relatório é lançamento contábil. O total recuperável é teto de cálculo, não crédito.']
  ];
  bugs.forEach(([r2, txt]) => { campo(r2, txt); doc.y += 3; });

  // ------------------------------------------------------------------ cabeçalho e rodapé
  const range = doc.bufferedPageRange();
  for (let i = 1; i < range.count; i++) {
    doc.switchToPage(i);
    const mb = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.rect(0, 0, W * 0.7, 2).fill(C.esmeralda); doc.rect(W * 0.7, 0, W * 0.3, 2).fill(C.ouro);
    doc.image(LOGO, W - M - 70, 26, { height: 16 });
    doc.font('B').fontSize(7.5).fillColor(C.tinta).text('REVERSA', W - M - 50, 31, { lineBreak: false, characterSpacing: 1 });
    doc.font('B').fontSize(7.5).fillColor(C.esmeralda).text('GOV', W - M - 50 + doc.font('B').fontSize(7.5).widthOfString('REVERSA ', { characterSpacing: 1 }) + 1, 31, { lineBreak: false, characterSpacing: 1 });
    regua(H - 50, C.linha, 0.5);
    doc.font('S').fontSize(7.5).fillColor(C.tinta).text('Reversa Gov', M, H - 40, { lineBreak: false });
    doc.font('R').fontSize(7.5).fillColor(C.muted).text('  ·  uma solução Argus Prime', M + doc.font('S').fontSize(7.5).widthOfString('Reversa Gov'), H - 40, { lineBreak: false });
    doc.font('R').fontSize(7.5).fillColor(C.muted).text(`${rotuloDoc} · Prefeitura de ${capitular(municipio)}     ${i + 1} / ${range.count}`, M + 170, H - 40, { width: LW - 170, align: 'right', lineBreak: false, ellipsis: true });
    doc.page.margins.bottom = mb;
  }
  doc.end();
  return fim;
}

(async () => {
  const d = carregar();
  const buf = await gerar(d);
  fs.writeFileSync(d.arqOut, buf);
  console.log(`  pdf gravado: ${d.arqOut} (${(buf.length / 1024).toFixed(0)} KB)`);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
