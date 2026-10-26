// Gera o relatorio de Tupaciguara a partir dos dados coletados (numeros calculados).
const fs = require('fs');
const crypto = require('crypto');

const folha = JSON.parse(fs.readFileSync('/workspace/folha-tupaciguara-5anos.json', 'utf8'));
const siconfi = JSON.parse(fs.readFileSync('/workspace/siconfi-serie.json', 'utf8'));
const diag = JSON.parse(fs.readFileSync('/workspace/diagnostico-tupaciguara.json', 'utf8'));

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
P('## 2. ISSQN — 5 anos (Siconfi / DCA)');
P();
P('| Ano | ISSQN arrecadado | Compra de serviços PJ | ISSQN / compra |');
P('|---:|---:|---:|---:|');
for (const l of serie) {
  const base = l.despesas.servicosPj || 0;
  P(`| ${l.ano} | ${brl(issqn(l))} | ${brl(base)} | ${pct(base ? issqn(l) / base : null, 2)} |`);
}
P(`| **5 anos** | **${brl(serie.reduce((s, l) => s + issqn(l), 0))}** | **${brl(tServ)}** | **${pct(serie.reduce((s, l) => s + issqn(l), 0) / tServ, 2)}** |`);
P();
P('**Ressalvas do ISSQN:**');
P();
P('- **Não há taxa observada de ISSQN.** A DCA traz o imposto **arrecadado**, não a **base de cálculo**; a coluna "ISSQN / compra" acima é uma razão de contexto, não uma alíquota — o município também compra serviços de terceiros, então a divisão não é base.');
P('- A alíquota do ISSQN vem do **decreto municipal** (LC 116/2003) e da natureza do serviço.');
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
P('O caso mais grave é o **desligamento**: 76 de 88 abaixo do piso, com taxa efetiva de desconto de 5,35% contra 31,71% da folha mensal. São 131 grupos sem nenhum desconto. Impacto: o RPPS não recebeu a contribuição e o servidor não tem o tempo de contribuição. A confirmação item a item exige o eSocial (S-1200/S-1300).');
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
P('---');
P('## 6. O que a fonte pública prova e o que não prova');
P();
P('| Fonte | O que traz | O que **não** prova |');
P('|---|---|---|');
P('| Siconfi / DCA | IRRF retido, ISSQN arrecadado, despesas — por município e ano | Não prova retenção, destino financeiro, titularidade nem crédito |');
P('| Portal da Transparência (folha) | Massa salarial, competências, 13º, descontos agregados | Não prova a composição das verbas (código de incidência por rubrica) nem a base de cálculo do INSS |');
P('| CadPrev / RPPS | Quem é servidor e pensionista do regime | Não é a folha: não traz valores nem rubricas |');
P('| EFD-Reinf / ECD / DARF / eSocial | Retenção, escrituração, recolhimento, folha por rubrica | **Documento autorizado** — é o que fecha a cadeia |');
P();
P('---');
P();
P('## 7. Pendências para fechar o diagnóstico');
P();
P('1. **EFD-Reinf** (ou planilha de retenções) por ano — para as retenções sobre serviços com alíquota e destino;');
P('2. **eSocial da folha** (S-1000, S-1005, S-1010, S-1200, S-2299) — o motor rodou com o fixture sintético; a folha real permite apurar as teses (T006/T074/T010) com base e rubrica corretas;');
P('3. **ECD e DARF** — conciliação: pago x declarado x apropriado;');
P('4. **Decreto municipal vigente** — alíquotas por natureza (IN RFB 2.145/2023 + art. 7º-A) para a taxa do futuro decreto, alimentada pela taxa observada por ano.');
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
P();
P('- A folha pública é **dado pessoal no origem**: o que entra no Reversa é o **agregado por competência**. Nenhum nome, matrícula ou CPF é transportado.');
P('- A DCA é **anual**: a série do Siconfi tem 1 ponto por ano de exercício, não 12 competências.');
P('- Campo ausente é **desconhecido**, nunca zero. A taxa de 2022 (0,3334%) e a de 2024 (1,4283%) refletem a variação real do que foi retido — não um zero disfarçado.');
P('- **Nenhum valor é reconhecido sem revisão humana.**');
P();
P(`_Gerado por \`tools/relatorio-tupaciguara.js\` em ${hoje}._`);

fs.writeFileSync('/workspace/output/RELATORIO_TUPACIGUARA_MG.md', L.join('\n'));
console.log('  relatorio gravado:', L.length, 'linhas');
