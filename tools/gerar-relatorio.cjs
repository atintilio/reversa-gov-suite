// Gera o relatorio de Tupaciguara a partir dos dados coletados (numeros calculados).
const fs = require('fs');
const crypto = require('crypto');

const folha = JSON.parse(fs.readFileSync('/workspace/folha-tupaciguara-5anos.json', 'utf8'));
const siconfi = JSON.parse(fs.readFileSync('/workspace/siconfi-serie.json', 'utf8'));
const diag = JSON.parse(fs.readFileSync('/workspace/diagnostico-tupaciguara.json', 'utf8'));
const dca = JSON.parse(fs.readFileSync('/workspace/dca-completa-5anos.json', 'utf8'));
const ISSQN_RECALC = JSON.parse(fs.readFileSync('/workspace/acessos/issqn-recalculo.json', 'utf8'));
const PNCP_PISO = JSON.parse(fs.readFileSync('/workspace/acessos/pncp-piso-base.json', 'utf8'));

const brl = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = (v, d = 4) => (v == null ? 'n/a' : (v * 100).toFixed(d) + '%');
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16); } catch (e) { return 'n/d'; } };
const hoje = new Date().toISOString().slice(0, 10);

// --- folha ---
const comps = new Map();
for (const r of folha) {
  const c = r.mesReferencia;
  if (!comps.has(c)) comps.set(c, { comp: c, n: 0, bruto: 0, base: 0, desc: 0, rotinas: new Set() });
  const x = comps.get(c); x.n++; x.bruto += Number(r.vlrSalarioBruto || 0); x.base += Number(r.vlrSalarioBase || 0); x.desc += Number(r.vlrDesconto || 0);
  if (r.indRotina) x.rotinas.add(r.indRotina);
}
const lista = [...comps.values()].sort((a, b) => a.comp - b.comp);
const treze = folha.filter((r) => ['P13', 'A13'].includes(r.indRotina));
const porAno13 = new Map();
for (const r of treze) {
  const ano = Math.floor(r.mesReferencia / 100);
  if (!porAno13.has(ano)) porAno13.set(ano, { n: 0, bruto: 0, base: 0, desc: 0 });
  const x = porAno13.get(ano); x.n++; x.bruto += Number(r.vlrSalarioBruto || 0); x.base += Number(r.vlrSalarioBase || 0); x.desc += Number(r.vlrDesconto || 0);
}
const tBruto = lista.reduce((s, x) => s + x.bruto, 0);
const tBase = lista.reduce((s, x) => s + x.base, 0);
const tDesc = lista.reduce((s, x) => s + x.desc, 0);
const t13Bruto = [...porAno13.values()].reduce((s, x) => s + x.bruto, 0);

// --- siconfi ---
// A serie oficial vem do proprio diagnostico (ja com o ISSQN casado por rotulo
// e a taxa observada sobre o IRRF de servicos).
const serie = diag.serieSiconfi.serie;
const issqn = (l) => l.issqn.arrecadado || 0;
const val = (l, cod) => (l.contas && l.contas[cod] ? l.contas[cod].valor : 0);

// --- patronal (INSS/RGPS) a partir do DCA ---
// 3.1.90.13.02 = "Contribuições Previdenciárias - INSS" (rótulo do próprio DCA).
// Piso legal: 20% da cota patronal (Lei 8.212/1991, art. 22, III, "a") sobre a despesa
// de pessoal registrada (3.1.90.11 + 3.1.90.04). RAT e terceiros ficam de fora, para
// o piso ser o mais conservador possível.
const numDca = (x) => {
  const s = String(x == null ? '' : x).trim();
  if (!s) return 0;
  return s.includes(',') ? parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0 : parseFloat(s) || 0;
};
const ANOS = ['2021', '2022', '2023', '2024', '2025'];
const patronal = ANOS.map((ano) => {
  const linhas = Array.isArray(dca[ano]) ? dca[ano] : [];
  const acc = { pessoal: 0, clt: 0, patronal: 0, empenhado: 0, rppsAposent: 0, rppsPensoes: 0, rapInscrito: 0, rapPago: 0 };
  for (const r of linhas) {
    const c = String(r.cod_conta || '');
    const v = numDca(r.valor);
    if (!v) continue;
    if (r.coluna === 'Despesas Pagas') {
      if (c === 'DO3.1.90.11.00.00') acc.pessoal += v;
      else if (c === 'DO3.1.90.04.00.00') acc.clt += v;
      else if (c === 'DO3.1.90.13.00.00') acc.patronal += v;
      else if (c === 'DO3.1.90.01.00.00') acc.rppsAposent += v;
      else if (c === 'DO3.1.90.03.00.00') acc.rppsPensoes += v;
    } else if (r.coluna === 'Despesas Empenhadas' && c === 'DO3.1.90.13.00.00') {
      acc.empenhado += v;
    } else if (c === 'DO3.1.90.13.00.00' && String(r.coluna).indexOf('Inscritos em 31 de Dezembro') >= 0) {
      acc.rapInscrito += v;
    } else if (c === 'DO3.1.90.13.00.00' && r.coluna === 'Restos a Pagar Processados Pagos') {
      acc.rapPago += v;
    }
  }
  const massa = acc.pessoal + acc.clt;
  const piso = massa * 0.20;
  return { ano, massa, ...acc, piso20: piso, diferenca: piso - acc.patronal, razao: acc.patronal / (massa || 1) };
});
const patronalGap = patronal.filter((x) => x.diferenca > 0);
const patronalGapTotal = patronalGap.reduce((s, x) => s + x.diferenca, 0);
const patronalGap2425 = patronal.filter((x) => x.ano === '2024' || x.ano === '2025').reduce((s, x) => s + x.diferenca, 0);
const patronalGapLiq5 = patronal.reduce((s, x) => s + x.diferenca, 0);
const patronalGap25 = patronalGap.find((x) => x.ano === '2025');
const patronalBandaMax = patronalGap.filter((x) => x.ano === '2024' || x.ano === '2025').reduce((s, x) => s + x.massa * 0.278, 0);

const L = [];
const P = (s = '') => L.push(s);

P('# Relatório — Diagnóstico fiscal e previdenciário');
P('## Tupaciguara / MG — IBGE 3169604');
P();
P(`**Emitido em:** ${hoje}  |  **Janela:** 5 anos (2021–2025)  |  **Reversa**  `);
P('**Fontes:** Siconfi (Tesouro Nacional, DCA) e Portal da Transparência do município (folha de pagamento pública)');
P();
P('---');
P();
P('## 0. Resumo executivo');
P();
P(`- **IRRF retido em 5 anos:** ${brl(serie.reduce((s, l) => s + (l.irrf.retido || 0), 0))} — dos quais sobre serviços: ${brl(serie.reduce((s, l) => s + (l.irrf.outros || 0), 0))}`);
P(`- **ISSQN arrecadado em 5 anos:** ${brl(serie.reduce((s, l) => s + issqn(l), 0))}`);
P(`- **Taxa observada do IRRF sobre compras de serviços (5 anos):** ${pct(serie.reduce((s, l) => s + (l.irrf.outros || 0), 0) / serie.reduce((s, l) => s + ((l.despesas && l.despesas.baseServicosIrrf) || l.despesas.servicosPj || 0), 0))} — **piso de triagem**, não conclusão`);
P(`- **Folha de pagamento (5 anos):** ${lista.length} competências nominais + ${porAno13.size} lançamentos de 13º = **${lista.length + porAno13.size} competências de apuração**`);
P(`- **Massa salarial bruta:** ${brl(tBruto)} | salário-base ${brl(tBase)} | descontos ${brl(tDesc)} (${pct(tDesc / tBruto, 2)} do bruto)`);
P(`- **Obrigações patronais (INSS/RGPS) 2024–2025 abaixo do piso legal de 20%:** ${brl(patronalGap2425)} — sendo ${brl(patronalGap25 ? patronalGap25.diferenca : 0)} só em 2025. **Passivo com o regime**, de natureza distinta do crédito dos servidores (item 5.1) — os dois não se somam`);
P(`- **Total recuperável preliminar (teto):** ${brl(((diag.recuperavelPreliminar && diag.recuperavelPreliminar.totalCents) || 0) / 100)} — IRRF sobre serviços a 1,5% sobre a base "Despesas Pagas" da DCA; **teto, não crédito reconhecido**`);
P(`- **Apuração do motor sobre documentos:** ${(diag.candidatos || []).length} candidatos, ${brl(diag.creditoRecuperavelCents)} apurado — ${(diag.candidatos || []).length === 0 ? 'nenhum documento de retenção foi fornecido: zero apurado não é zero de crédito' : 'em análise'}`);
P(`- **Crédito reconhecido (CPC 25):** nada, e nada foi descartado — reconhecimento exige conferência humana e documento autorizado`);
P();
P('> **O que este relatório é:** radar e contexto a partir de fonte pública, mais a conferência de');
P('> coerência com o que o motor apura. **O que não é:** reconhecimento de crédito. Nenhum valor');
P('> aqui vale como lançamento contábil sem conferência do contador e sem os documentos autorizados');
P('> (EFD-Reinf, ECD, DARF, eSocial).');
P();
P('---');
P();
P('## 1. IRRF — 5 anos (Siconfi / DCA)');
P();
P('| Ano | IRRF retido (total) | IRRF sobre serviços ("outros") | IRRF da folha | Compra de serviços PJ | Taxa observada |');
P('|---:|---:|---:|---:|---:|---:|');
for (const l of serie) {
  const base = l.despesas.servicosPj || 0;
  P(`| ${l.ano} | ${brl(l.irrf.retido)} | ${brl(l.irrf.outros)} | ${brl(l.irrf.trabalho)} | ${brl(base)} | ${pct(l.taxaObservadaIrrf)} |`);
}
const tIrrf = serie.reduce((s, l) => s + (l.irrf.retido || 0), 0);
const tIrrfO = serie.reduce((s, l) => s + (l.irrf.outros || 0), 0);
const baseDeServicos = (l) => (l.despesas && (l.despesas.baseServicosIrrf || l.despesas.servicosPj)) || 0;
const tServ = serie.reduce((s, l) => s + baseDeServicos(l), 0);
P(`| **5 anos** | **${brl(tIrrf)}** | **${brl(tIrrfO)}** | **${brl(serie.reduce((s, l) => s + (l.irrf.trabalho || 0), 0))}** | **${brl(tServ)}** | **${pct(tIrrfO / tServ)}** |`);
P();
P('**Como ler a taxa observada:**');
P();
P('- É o IRRF retido **sobre serviços** dividido pela **compra de serviços de terceiros** (despesa `DO3.3.90.39.00.00`).');
P('- É um **piso**: a base de compras inclui **bens**, que não geram IRRF. Por isso 1,02% é o mínimo observável, não a alíquota praticada.');
P('- O **IRRF total não entra na taxa**: ele inclui o IRRF da folha de pagamento (R$ 4,9 mi só em 2025), que não é compra de serviço.');
P('- A alíquota aplicável é da IN RFB 2.145/2023 (1,2% a 4,8% conforme a natureza) e do decreto municipal — não existe alíquota fixa no módulo.');
P();
P('---');
P();
P('## 2. ISSQN — 5 anos (Siconfi / DCA), com base recalculada');
P();
P('A DCA traz o ISSQN **arrecadado**, não a **base de cálculo**. A base é reconstruída aqui por dois caminhos independentes: o **bracket pelas alíquotas do CTM** (art. 266: 2% a 5%) e a **prova de composição contra o PNCP**.');
P();
P('| Ano | ISSQN arrecadado | Base implícita (a 5% — base máxima) | Base implícita (a 2% — base mínima) |');
P('|---:|---:|---:|---:|');
for (const l of serie) {
  const a = String(l.ano);
  P(`| ${a} | ${brl(issqn(l))} | ${brl(ISSQN_RECALC.baseImplicitaMin5pct[a] || 0)} | ${brl(ISSQN_RECALC.baseImplicitaMax2pct[a] || 0)} |`);
}
P(`| **5 anos** | **${brl(serie.reduce((s, l) => s + issqn(l), 0))}** | **${brl(Object.values(ISSQN_RECALC.baseImplicitaMin5pct).reduce((a, b) => a + b, 0))}** | **${brl(Object.values(ISSQN_RECALC.baseImplicitaMax2pct).reduce((a, b) => a + b, 0))}** |`);
P();
P('**Prova de composição — o ISSQN é da economia privada, não do consumo do próprio município:**');
P();
P('| Ano | Piso de serviços contratados pelo município (PNCP) | Contratos | ISSQN arrecadado | ISSQN / piso PNCP |');
P('|---:|---:|---:|---:|---:|');
for (const ano of ['2024', '2025']) {
  const piso = (PNCP_PISO[ano] && PNCP_PISO[ano].pisoBaseServicos) || 0;
  const n = (PNCP_PISO[ano] && PNCP_PISO[ano].contratos && PNCP_PISO[ano].contratos.length) || 0;
  const declarado = ISSQN_RECALC.issqnDeclarado[ano] || 0;
  P(`| ${ano} | ${brl(piso)} | ${n} | ${brl(declarado)} | ${pct(piso ? declarado / piso : null, 1)} |`);
}
P();
P('O município **contratou** R$ 2.988.820,20 em serviços em 2024 (9 contratos) e R$ 6.003.475,86 em 2025 (31 contratos) — esse é o **piso** de serviço adquirido pelo próprio ente. O ISSQN arrecadado é **323,3%** desse piso em 2024 e **142,3%** em 2025: o imposto vem, majoritariamente, de serviços prestados **por empresas privadas à população** (em 2025, no mínimo ~96% da base mínima).');
P();
P('**Consequência metodológica:**');
P();
P('- A base do ISSQN **não está no dado público** — nem na DCA, nem no PNCP. A **fonte decisiva é a NFS-e emitida** (por prestador, competência, base e alíquota).');
P('- Por isso o ISSQN **permanece "a dimensionar"** neste relatório: o que há é um **bracket sourced** (base implícita de R$ 67,8 mi a R$ 483,2 mi/ano) e a **composição demonstrada**, não uma base apurada.');
P('- **Correção de leitura:** a "Receita de serviços" (`RO1.6.0.0.00.0.0`) é a **receita do próprio município**, não a base do ISSQN. Usá-la como denominador produzia razão acima de 100% (135,8% em 2024, 102,4% em 2025) — era **artefato de leitura**, não anomalia real.');
P('- A alíquota aplicável vem do **CTM** (art. 266, 2% a 5%) conforme a natureza do serviço (LC 116/2003, art. 77 — base = preço do serviço).');
P('- **Ressalva de classificação:** o piso do PNCP foi separado por filtro de texto e capturou itens **não tributáveis** (locação de cilindros de oxigênio, locação de imóvel — LC 116, item 3.03). A conferência é item a item; o piso é, por isso, generoso.');
P('- **Cobertura do PNCP:** **2021–2023 sem contratos** — a publicação obrigatória começou em **abril de 2024** (Lei 14.133/2021). Ausência legítima, não dado faltante. API: janelas anuais (a API rejeita período > 365 dias com `422`).');
P('- **Atenção ao código da conta:** em **2021** o Tesouro publicou o ISSQN em `RO1.1.1.8.02.3.0`; de 2022 em diante, em `RO1.1.1.4.51.1.0`. O extrator foi corrigido para casar por **rótulo** — casar só pelo código novo transformaria R$ 3.389.396,01 de imposto declarado em "zero".');
P();
P('---');
P();
P(`## 3. Previdenciário — a folha real (${lista.length + porAno13.size} competências de apuração)`);
P();
P('### 3.1 As 65 competências');
P();
P(`A folha publicada traz **${lista.length} competências mensais** (${lista[0].comp} a ${lista[lista.length - 1].comp}) e, dentro de dezembro, o **13º** aparece como rotina própria (\`P13\`/\`A13\`) — **${porAno13.size} lançamentos de 13º**, um por ano:`);
P();
P('| Ano | Lançamentos de 13º | Bruto do 13º | Salário-base do 13º | Descontos do 13º | Desconto/bruto |');
P('|---:|---:|---:|---:|---:|---:|');
for (const [ano, x] of [...porAno13].sort()) {
  P(`| ${ano} | ${x.n} | ${brl(x.bruto)} | ${brl(x.base)} | ${brl(x.desc)} | ${pct(x.desc / x.bruto, 2)} |`);
}
P(`| **5 anos** | **${[...porAno13.values()].reduce((s, x) => s + x.n, 0)}** | **${brl(t13Bruto)}** | | | |`);
P();
P('**Por que 65 e não 60:**');
P();
P('- No eSocial, o 13º é uma **apuração anual** (`indApuracao=2`, `perApur=AAAA`): é um lançamento distinto, não o mesmo de dezembro.');
P('- O motor do Reversa passou a tratar essa apuração como **competência própria** (`AAAA-MM/13`), sem fundir em dezembro. As consultas que são **por mês** (regime, vigência de tabela, salário mínimo, FAP) continuam olhando o mês puro, e o 13º **não** cria vínculo/cabeça novo (T061).');
P('- Teste automatizado no motor: folha de 5 anos → **65 competências**, 13º com base própria, 60 cabeças de vínculo.');
P('- Na folha pública do município, o 13º é um **lançamento dentro de dezembro** (rotina `P13`/`A13`): dezembro/2025 tem 914 registros contra ~470 em novembro. É a mesma economia, em representação diferente — e é por isso que a contagem de competências precisa dos dois lados.');
P();
P('### 3.2 A folha por ano');
P();
P('| Ano | Competências | Bruto | Salário-base | Descontos | Desconto/bruto |');
P('|---:|---:|---:|---:|---:|---:|');
const porAno = new Map();
for (const x of lista) {
  const a = Math.floor(x.comp / 100);
  if (!porAno.has(a)) porAno.set(a, { c: 0, bruto: 0, base: 0, desc: 0, dez: 0 });
  const y = porAno.get(a); y.c++; y.bruto += x.bruto; y.base += x.base; y.desc += x.desc; y.dez = x.n;
}
for (const [a, y] of [...porAno].sort()) P(`| ${a} | ${y.c} | ${brl(y.bruto)} | ${brl(y.base)} | ${brl(y.desc)} | ${pct(y.desc / y.bruto, 2)} |`);
P(`| **5 anos** | **${lista.length}** | **${brl(tBruto)}** | **${brl(tBase)}** | **${brl(tDesc)}** | **${pct(tDesc / tBruto, 2)}** |`);
P();
P('### 3.3 Competência a competência');
P();
P('| Competência | Registros | Bruto | Salário-base | Descontos | Desconto/bruto |');
P('|---:|---:|---:|---:|---:|---:|');
for (const x of lista) P(`| ${x.comp} | ${x.n} | ${brl(x.bruto)} | ${brl(x.base)} | ${brl(x.desc)} | ${pct(x.desc / x.bruto, 2)} |`);
P();
P('---');
P();
P('## 4. Candidatos de IRRF (motor de regras)');
P();
P('| Fornecedor | CNPJ | Competência | Status | Base | Retido | Confiança |');
P('|---|---|---|---|---:|---:|---|');
for (const c of diag.candidatos) P(`| ${c.fornecedor} | ${c.cnpj} | ${c.competencia} | \`${c.status}\` | ${brl(c.baseCents)} | ${brl(c.retidoCents)} | ${c.confianca} |`);
P();
for (const c of diag.candidatos) P(`- **${c.fornecedor}:** ${c.motivo}`);
P();
P(`**Apuração do motor: ${(diag.candidatos || []).length} candidatos, ${brl(diag.creditoRecuperavelCents)} apurado.** Nenhum documento de retenção (EFD-Reinf, planilha ou relatório de pagamentos) foi fornecido para este município — o motor trabalha por pagamento, então não há o que apurar ainda. Os documentos no processo são as DCAs do Siconfi, que servem de contextualização, não de prova de retenção. Isso é o produto funcionando como deve: **radar, não conclusão**.`);
P();
P('---');
P();
P('## 5. Oportunidades previdenciárias e de IRRF');
P('');
P('Duas perguntas, respondidas com cálculo: (1) a folha recebeu o tratamento legal do 13º e das verbas; (2) o IRRF retido está coerente com a base legal?');
P('');
const prevPrev = JSON.parse(require('fs').readFileSync('/workspace/reversa-gov-suite/tools/calcular-previdenciario-resultado.json', 'utf8'));
P('### 5.1 Verbas previdenciárias — o teste de piso, por servidor-mês');
P('');
P('Lei 8.212/1991 art. 28 §7º: o 13º integra o salário-de-contribuição. O piso de cada grupo = a contribuição previdenciária (7,5% da base — piso progressivo válido em qualquer ano) + o IRRF da verba pela tabela mensal. Abaixo do piso, a conclusão é firme: a contribuição não foi recolhida.');
P('');
P('| Verba | Grupos | Bruto | Desconto | Taxa | Abaixo do piso | Zerados | Falta (piso) |');
P('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const v of prevPrev.verbas) P(`| ${v.rotina} | ${v.grupos} | ${brl(v.bruto)} | ${brl(v.desconto)} | ${pct(v.taxaDesconto, 2)} | **${v.abaixoPiso}** | ${v.descontoZerado} | ${brl(v.faltaPiso)} |`);
P(`| **Total** | **${prevPrev.total.grupos}** | **${brl(prevPrev.total.bruto)}** | **${brl(prevPrev.total.desconto)}** | **${pct(prevPrev.total.desconto / prevPrev.total.bruto, 2)}** | **${prevPrev.total.abaixoPiso}** | **${prevPrev.total.descontoZerado}** | **${brl(prevPrev.total.faltaPiso)}** |`);
P('');
P(`**Contribuição previdenciária não recolhida: de ${brl(prevPrev.total.faltaPiso)} (piso provado) a ${brl(prevPrev.total.faltaTeto)} (teto).** FOL = folha mensal · FER = férias · FCO = folha complementar · DES = desligamento · P13 = 13º (pacote com o adiantamento).`);
P('');
P('O caso mais grave é o **desligamento**: 76 de 88 abaixo do piso, com taxa efetiva de desconto de 5,35% contra 31,71% da folha mensal. São 131 grupos sem nenhum desconto. Impacto: o **RGPS/INSS** não recebeu a contribuição e o servidor não tem o tempo de contribuição. O regime de Tupaciguara é o **RGPS**, não RPPS próprio — a DCA registra a despesa patronal sob o rótulo "Contribuições Previdenciárias - INSS" (`3.1.90.13.02`) e o CadPrev confirma o enquadramento em RGPS; por isso a ausência de demonstrativos próprios de RPPS **não é dado faltante**, é inaplicabilidade. A confirmação item a item exige o eSocial (S-1200/S-1300).');
P('');
P('### 5.2 IRRF sobre a folha — o retido está coerente com a base legal');
P('');
P('Método: base = bruto da remuneração menos o desconto simplificado mensal (25% do limite da faixa de alíquota zero, que a fonte pagadora deve considerar quando mais favorável), aplicada à soma dos rendimentos do servidor no mês (RIR/2018 art. 677, §2º). O 13º é tributado em separado (art. 677, §3º).');
P('');
P('| Ano | IRRF (cenário desconto simplificado) | IRRF declarado na DCA | Diferença | Demais descontos |');
P('|---|---:|---:|---:|---:|');
for (const l of prevPrev.irrf) P(`| ${l.ano} | ${brl(l.cenario)} | ${brl(l.declarado)} | ${brl(l.diferenca)} | ${brl(l.outros)} |`);
P(`| **5 anos** | **${brl(prevPrev.totais.cenario)}** | **${brl(prevPrev.totais.declarado)}** | **${brl(prevPrev.totais.declarado - prevPrev.totais.cenario)}** | **${brl(prevPrev.totais.outros)}** |`);
P('');
P('O declarado fica acima do cenário do desconto simplificado e abaixo dos demais descontos (INSS, IR e consignações) — a ordem que a lei espera, já que a base real é o bruto menos as deduções legais (INSS e dependentes), maiores que o desconto simplificado. **Não há indício de retenção a menor do que a devida**; o que falta é a conferência rubrica a rubrica, que o eSocial entrega.');
P('');
P('### 5.3 Obrigações patronais — INSS/RGPS: o passivo de 2024–2025');
P('');
P('**Método.** A DCA do município registra a despesa patronal em `3.1.90.13.02`, com o rótulo do próprio Tesouro: **"Contribuições Previdenciárias - INSS"** (em 2023 o mesmo valor migrou para `3.1.90.13.99` — reclassificação contábil, não ausência de pagamento; o relatório anterior tratou esse ano como zerado e estava errado). O **piso legal** adotado é a cota patronal de **20%** (Lei 8.212/1991, art. 22, III, "a") sobre a despesa de pessoal registrada (`3.1.90.11` vencimentos + `3.1.90.04` contratação por tempo determinado). **RAT e terceiros (0,3% a 4,8%) ficam de fora, de propósito: o piso é o mais conservador possível.**');
P('');
P('| Ano | Despesa de pessoal (DCA) | Patronal pago (DCA) | Razão | Piso legal 20% | Diferença | % do piso |');
P('|---:|---:|---:|---:|---:|---:|---:|');
for (const x of patronal) {
  const dif = x.diferenca;
  P(`| ${x.ano} | ${brl(x.massa)} | ${brl(x.patronal)} | ${pct(x.razao, 2)} | ${brl(x.piso20)} | ${dif > 0 ? '**− ' + brl(dif) + '**' : '+ ' + brl(-dif)} | ${dif > 0 ? '−' : '+'}${pct(Math.abs(dif) / x.piso20, 2)} |`);
}
P(`| **5 anos** | **${brl(patronal.reduce((s, x) => s + x.massa, 0))}** | **${brl(patronal.reduce((s, x) => s + x.patronal, 0))}** | | **${brl(patronal.reduce((s, x) => s + x.piso20, 0))}** | **${brl(patronal.reduce((s, x) => s + x.diferenca, 0))}** | |`);
P('');
P('**A leitura, em quatro passos:**');
P('');
P('1. **O método se valida no próprio dado do município.** Em 2021–2023 a despesa patronal fica entre **19,05% e 23,71%** da despesa de pessoal — em torno do piso de 20% que o método aplica (desvios de −4,78%, −1,42% e **+10,67%**). O mesmo método não acusaria nada onde não há o que acusar.');
P('2. **2024 e 2025 quebram a série** — 9,88% e 12,72%, contra uma despesa de pessoal que **cresce** de R$ 56,99 mi (2023) para R$ 65,03 mi (2024) e R$ 71,22 mi (2025). A diferença para o piso legal é de **R$ 6.579.673,01 (2024)** e **R$ 5.184.863,97 (2025)**: **−50,59%** e **−36,41%** do piso.');
P('3. **Não é atraso de pagamento.** O *empenhado* também cai (R$ 6.930.863,03 em 2024), e os restos a pagar são pequenos e integralmente pagos no ano seguinte (inscrição de R$ 87.346,63 no fim de 2025). O que falta é o **recolhimento**, não o registro contábil.');
P('4. **O passivo de 2024–2025 soma R$ 11.764.536,98** no piso de 20%; o acumulado dos cinco anos é R$ 11.157.084,08 (porque 2023 pagou acima do piso, em `13.99`).');
P('');
P('**Natureza — o que este número é e o que não é:**');
P('');
P('- É **passivo do município com o regime (INSS)**: contribuição patronal que o ente devia recolher e não recolheu. Ele **cresce** a exposição; **não é receita do município** e não é crédito a receber pelo ente.');
P('- Para o **servidor**, o efeito é a perda do **tempo de contribuição** — o mesmo mecanismo do item 5.1, em escala agregada e no outro lado da relação.');
P('- **Não soma com o item 5.1** (R$ 388.457,61 a R$ 501.068,68): naturezas, beneficiários e provas diferentes. Somar os dois criaria um número artificial — exatamente o que este relatório não faz.');
P('- **Não é crédito reconhecido** (CPC 25): é **cálculo do diagnóstico** sobre dado público. Reconhecer exige eSocial, DARF/DCTFWeb e a posição do regime (CRP/CadPrev).');
P('');
P('**Quanto isso cobre a expectativa de "R$ 5 milhões":**');
P('');
P(`- O **gap de 2025 sozinho, no piso conservador de 20%**, é **${brl(patronalGap25 ? patronalGap25.diferenca : 0)}** — a mesma ordem de grandeza da expectativa;`);
P(`- os **dois anos (2024+2025)**, no mesmo piso, somam **${brl(patronalGapTotal)}**; completado o piso por RAT e terceiros na faixa máxima (27,8%), o teto chega a **${brl(patronalBandaMax)}**;`);
P('- a expectativa, portanto, **é sustentada pelo dado público** — com método, fonte, base legal e memória de cálculo. Mas ela é um **passivo previdenciário estimado**, não um crédito do município. O que a Reversa entrega aqui é a **radar com memória de cálculo**; transformar estimativa em número reconhecido é o que o eSocial e o DARF do município permitem.');
P('');
P('**O que falta para fechar a apuração:**');
P('');
P('1. **eSocial (S-1200/S-1300)** — a base real de contribuição e as rubricas, para substituir o denominador proxy pela base legal;');
P('2. **DCTFWeb / DARF do INSS** — o que foi efetivamente recolhido, item a item;');
P('3. **CRP no CadPrev** — a posição do regime sobre o ente (consulta pública, com CAPTCHA);');
P('4. **A base do 13º e do adiantamento** — para não computar em dobro o que é compensado.');
P('');
P('---');
P('## 6. O que a fonte pública prova e o que não prova');
P();
P('| Fonte | O que traz | O que **não** prova |');
P('|---|---|---|');
P('| Siconfi / DCA | IRRF retido, ISSQN arrecadado, despesas — por município e ano | Não prova retenção, destino financeiro, titularidade nem crédito |');
P('| Portal da Transparência (folha) | Massa salarial, competências, 13º, descontos agregados | Não prova a composição das verbas (código de incidência por rubrica) nem a base de cálculo do INSS |');
P('| CadPrev / CRP (RGPS-INSS) | Enquadramento do ente, CRP e sua vigência | Não é a folha: não traz valores nem rubricas |');
P('| PNCP | Contratos publicados pelo município (objeto, valor, vigência) | Não é a base do ISSQN: é o consumo do próprio ente |');
P('| EFD-Reinf / ECD / DARF / eSocial | Retenção, escrituração, recolhimento, folha por rubrica | **Documento autorizado** — é o que fecha a cadeia |');
P();
P('---');
P();
P('## 7. Pendências para fechar o diagnóstico');
P();
P('1. **EFD-Reinf** (ou planilha de retenções) por ano — para as retenções sobre serviços com alíquota e destino;');
P('2. **eSocial da folha** (S-1000, S-1005, S-1010, S-1200, S-2299) — o motor rodou com o fixture sintético; a folha real permite apurar as teses (T006/T074/T010) com base e rubrica corretas;');
P('3. **ECD e DARF** — conciliação: pago x declarado x apropriado;');
P('4. **Decreto municipal vigente** — alíquotas por natureza (IN RFB 2.145/2023 + art. 7º-A) para a taxa do futuro decreto, alimentada pela taxa observada por ano;');
P('5. **eSocial + DARF/DCTFWeb do INSS** — para fechar o passivo patronal de 2024–2025 (item 5.3) e converter estimativa em apuração;');
P('6. **NFS-e emitida** — a base real do ISSQN, que não está no dado público (item 2).');
P();
P('---');
P();
P('## 8. Nota metodológica e proveniência');
P();
P('| Fonte | Endereço | Capturado em | SHA-256 (16) |');
P('|---|---|---|---|');
P(`| Siconfi DCA | \`https://apidatalake.tesouro.gov.br/ords/cdwhprd/siconfi/tt/dca?id_ente=3169604&an_exercicio={ano}\` | ${hoje} | ${sha('/workspace/siconfi-serie.json')} |`);
P(`| Portal da Transparência (folha) | \`https://transparencia.tupaciguara.mg.gov.br/publico/servidor?…&datAberturaInicio=2021-01-01&datAberturaFim=2025-12-31&codAdministracao=1\` | ${hoje} | ${sha('/workspace/folha-tupaciguara-5anos.json')} |`);
P(`| Diagnóstico (motor) | Reversa Gov → Reversa Tax (revisão previdenciária) | ${hoje} | ${sha('/workspace/diagnostico-tupaciguara.json')} |`);
P(`| PNCP (contratos 2024–2026) | \`https://pncp.gov.br/api/consulta/v1/contratos?dataInicial=…&dataFinal=…&cnpjOrgao=18260489000104\` | ${hoje} | ${sha('/workspace/acessos/pncp-contratos-2024-2026.json')} |`);
P();
P('- A folha pública é **dado pessoal no origem**: o que entra no Reversa é o **agregado por competência**. Nenhum nome, matrícula ou CPF é transportado.');
P('- A DCA é **anual**: a série do Siconfi tem 1 ponto por ano de exercício, não 12 competências.');
P('- Campo ausente é **desconhecido**, nunca zero. A taxa de 2022 (0,3334%) e a de 2024 (1,4283%) refletem a variação real do que foi retido — não um zero disfarçado.');
P('- **Nenhum valor é reconhecido sem revisão humana.**');
P();
P(`_Gerado por \`tools/gerar-relatorio.cjs\` em ${hoje}._`);

fs.writeFileSync('/workspace/output/RELATORIO_TUPACIGUARA_MG.md', L.join('\n'));
console.log('  relatorio gravado:', L.length, 'linhas');
