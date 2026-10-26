# Relatório — Diagnóstico fiscal e previdenciário
## Tupaciguara / MG — IBGE 3169604

**Emitido em:** 2026-10-26  |  **Janela:** 5 anos (2021–2025)  |  **Reversa**  
**Fontes:** Siconfi (Tesouro Nacional, DCA) e Portal da Transparência do município (folha de pagamento pública)

---

## 0. Resumo executivo

- **IRRF retido em 5 anos:** R$ 18.570.688,41 — dos quais sobre serviços: R$ 1.308.479,89
- **ISSQN arrecadado em 5 anos:** R$ 31.927.162,66
- **Taxa observada do IRRF sobre compras de serviços (5 anos):** 0.9892% — **piso de triagem**, não conclusão
- **Folha de pagamento (5 anos):** 60 competências nominais + 5 lançamentos de 13º = **65 competências de apuração**
- **Massa salarial bruta:** R$ 139.948.795,78 | salário-base R$ 72.894.936,81 | descontos R$ 43.083.869,83 (30.79% do bruto)
- **Crédito recuperável apurado:** R$ 0,00 — os 2 candidatos estão em `NEEDS_EVIDENCE` (falta prova de destino e alíquota)

> **O que este relatório é:** radar e contexto a partir de fonte pública, mais a conferência de
> coerência com o que o motor apura. **O que não é:** reconhecimento de crédito. Nenhum valor
> aqui vale como lançamento contábil sem conferência do contador e sem os documentos autorizados
> (EFD-Reinf, ECD, DARF, eSocial).

---

## 1. IRRF — 5 anos (Siconfi / DCA)

| Ano | IRRF retido (total) | IRRF sobre serviços ("outros") | IRRF da folha | Compra de serviços PJ | Taxa observada |
|---:|---:|---:|---:|---:|---:|
| 2021 | R$ 2.322.986,06 | R$ 175.920,61 | R$ 2.147.065,45 | R$ 17.475.884,77 | 1.0066% |
| 2022 | R$ 2.907.335,09 | R$ 90.154,82 | R$ 2.817.180,27 | R$ 27.044.444,71 | 0.3334% |
| 2023 | R$ 3.287.206,09 | R$ 308.017,50 | R$ 2.979.188,59 | R$ 27.410.156,98 | 1.1237% |
| 2024 | R$ 4.805.550,15 | R$ 412.219,42 | R$ 4.393.330,73 | R$ 28.860.456,00 | 1.4283% |
| 2025 | R$ 5.247.611,02 | R$ 322.167,54 | R$ 4.925.443,48 | R$ 31.479.383,52 | 1.0234% |
| **5 anos** | **R$ 18.570.688,41** | **R$ 1.308.479,89** | **R$ 17.262.208,52** | **R$ 132.270.325,98** | **0.9892%** |

**Como ler a taxa observada:**

- É o IRRF retido **sobre serviços** dividido pela **compra de serviços de terceiros** (despesa `DO3.3.90.39.00.00`).
- É um **piso**: a base de compras inclui **bens**, que não geram IRRF. Por isso 1,02% é o mínimo observável, não a alíquota praticada.
- O **IRRF total não entra na taxa**: ele inclui o IRRF da folha de pagamento (R$ 4,9 mi só em 2025), que não é compra de serviço.
- A alíquota aplicável é da IN RFB 2.145/2023 (1,2% a 4,8% conforme a natureza) e do decreto municipal — não existe alíquota fixa no módulo.

---

## 2. ISSQN — 5 anos (Siconfi / DCA)

| Ano | ISSQN arrecadado | Compra de serviços PJ | ISSQN / compra |
|---:|---:|---:|---:|
| 2021 | R$ 3.389.396,01 | R$ 17.475.884,77 | 19.39% |
| 2022 | R$ 4.279.652,39 | R$ 27.044.444,71 | 15.82% |
| 2023 | R$ 6.049.598,93 | R$ 27.410.156,98 | 22.07% |
| 2024 | R$ 9.664.079,87 | R$ 28.860.456,00 | 33.49% |
| 2025 | R$ 8.544.435,46 | R$ 31.479.383,52 | 27.14% |
| **5 anos** | **R$ 31.927.162,66** | **R$ 132.270.325,98** | **24.14%** |

**Ressalvas do ISSQN:**

- **Não há taxa observada de ISSQN.** A DCA traz o imposto **arrecadado**, não a **base de cálculo**; a coluna "ISSQN / compra" acima é uma razão de contexto, não uma alíquota — o município também compra serviços de terceiros, então a divisão não é base.
- A alíquota do ISSQN vem do **decreto municipal** (LC 116/2003) e da natureza do serviço.
- **Atenção ao código da conta:** em **2021** o Tesouro publicou o ISSQN em `RO1.1.1.8.02.3.0`; de 2022 em diante, em `RO1.1.1.4.51.1.0`. O extrator foi corrigido para casar por **rótulo** — casar só pelo código novo transformaria R$ 3.389.396,01 de imposto declarado em "zero".

---

## 3. Previdenciário — a folha real (65 competências de apuração)

### 3.1 As 65 competências

A folha publicada traz **60 competências mensais** (202101 a 202512) e, dentro de dezembro, o **13º** aparece como rotina própria (`P13`/`A13`) — **5 lançamentos de 13º**, um por ano:

| Ano | Lançamentos de 13º | Bruto do 13º | Salário-base do 13º | Descontos do 13º | Desconto/bruto |
|---:|---:|---:|---:|---:|---:|
| 2021 | 514 | R$ 1.664.763,30 | R$ 957.199,95 | R$ 271.235,25 | 16.29% |
| 2022 | 998 | R$ 2.556.769,82 | R$ 2.077.824,32 | R$ 1.030.572,37 | 40.31% |
| 2023 | 487 | R$ 1.995.961,20 | R$ 1.084.137,62 | R$ 355.673,37 | 17.82% |
| 2024 | 470 | R$ 2.087.427,21 | R$ 1.100.159,72 | R$ 379.530,78 | 18.18% |
| 2025 | 449 | R$ 2.232.951,44 | R$ 1.121.446,62 | R$ 421.739,79 | 18.89% |
| **5 anos** | **2918** | **R$ 10.537.872,97** | | | |

**Por que 65 e não 60:**

- No eSocial, o 13º é uma **apuração anual** (`indApuracao=2`, `perApur=AAAA`): é um lançamento distinto, não o mesmo de dezembro.
- O motor do Reversa passou a tratar essa apuração como **competência própria** (`AAAA-MM/13`), sem fundir em dezembro. As consultas que são **por mês** (regime, vigência de tabela, salário mínimo, FAP) continuam olhando o mês puro, e o 13º **não** cria vínculo/cabeça novo (T061).
- Teste automatizado no motor: folha de 5 anos → **65 competências**, 13º com base própria, 60 cabeças de vínculo.
- Na folha pública do município, o 13º é um **lançamento dentro de dezembro** (rotina `P13`/`A13`): dezembro/2025 tem 914 registros contra ~470 em novembro. É a mesma economia, em representação diferente — e é por isso que a contagem de competências precisa dos dois lados.

### 3.2 A folha por ano

| Ano | Competências | Bruto | Salário-base | Descontos | Desconto/bruto |
|---:|---:|---:|---:|---:|---:|
| 2021 | 12 | R$ 23.671.590,19 | R$ 12.689.132,45 | R$ 6.644.963,55 | 28.07% |
| 2022 | 12 | R$ 26.443.635,78 | R$ 15.135.001,40 | R$ 8.517.535,25 | 32.21% |
| 2023 | 12 | R$ 28.202.363,54 | R$ 14.376.075,64 | R$ 8.663.052,51 | 30.72% |
| 2024 | 12 | R$ 29.932.716,08 | R$ 15.306.241,62 | R$ 9.278.645,19 | 31.00% |
| 2025 | 12 | R$ 31.698.490,19 | R$ 15.388.485,70 | R$ 9.979.673,33 | 31.48% |
| **5 anos** | **60** | **R$ 139.948.795,78** | **R$ 72.894.936,81** | **R$ 43.083.869,83** | **30.79%** |

### 3.3 Competência a competência

| Competência | Registros | Bruto | Salário-base | Descontos | Desconto/bruto |
|---:|---:|---:|---:|---:|---:|
| 202101 | 549 | R$ 1.791.633,54 | R$ 1.011.633,97 | R$ 514.791,41 | 28.73% |
| 202102 | 550 | R$ 2.145.831,65 | R$ 1.021.205,44 | R$ 518.043,25 | 24.14% |
| 202103 | 546 | R$ 1.833.218,01 | R$ 1.032.094,17 | R$ 523.335,80 | 28.55% |
| 202104 | 551 | R$ 1.838.836,00 | R$ 1.015.419,49 | R$ 520.927,26 | 28.33% |
| 202105 | 523 | R$ 1.887.851,47 | R$ 974.285,19 | R$ 528.076,83 | 27.97% |
| 202106 | 516 | R$ 1.785.095,57 | R$ 964.158,91 | R$ 529.653,61 | 29.67% |
| 202107 | 512 | R$ 1.816.883,27 | R$ 955.424,52 | R$ 530.800,28 | 29.21% |
| 202108 | 510 | R$ 1.781.802,88 | R$ 951.167,97 | R$ 532.013,04 | 29.86% |
| 202109 | 512 | R$ 1.796.469,68 | R$ 954.464,05 | R$ 536.436,86 | 29.86% |
| 202110 | 510 | R$ 1.779.453,61 | R$ 952.369,16 | R$ 543.633,50 | 30.55% |
| 202111 | 509 | R$ 1.777.975,36 | R$ 951.464,35 | R$ 541.364,71 | 30.45% |
| 202112 | 1021 | R$ 3.436.539,15 | R$ 1.905.445,23 | R$ 825.887,00 | 24.03% |
| 202201 | 814 | R$ 2.176.367,61 | R$ 1.619.389,87 | R$ 645.334,47 | 29.65% |
| 202202 | 516 | R$ 2.149.564,92 | R$ 1.058.209,04 | R$ 646.957,09 | 30.10% |
| 202203 | 511 | R$ 1.961.590,87 | R$ 1.053.386,48 | R$ 610.678,09 | 31.13% |
| 202204 | 509 | R$ 1.986.236,39 | R$ 1.047.209,38 | R$ 616.298,91 | 31.03% |
| 202205 | 498 | R$ 1.978.072,11 | R$ 1.028.037,59 | R$ 609.054,81 | 30.79% |
| 202206 | 509 | R$ 1.946.298,59 | R$ 1.042.847,83 | R$ 606.088,19 | 31.14% |
| 202207 | 494 | R$ 1.961.860,18 | R$ 1.026.625,62 | R$ 615.695,06 | 31.38% |
| 202208 | 495 | R$ 1.931.559,58 | R$ 1.028.034,26 | R$ 617.726,94 | 31.98% |
| 202209 | 996 | R$ 2.677.649,21 | R$ 2.076.680,49 | R$ 628.627,34 | 23.48% |
| 202210 | 514 | R$ 1.944.667,06 | R$ 1.065.250,28 | R$ 627.750,30 | 32.28% |
| 202211 | 489 | R$ 1.926.377,89 | R$ 1.018.901,55 | R$ 629.815,46 | 32.69% |
| 202212 | 993 | R$ 3.803.391,37 | R$ 2.070.429,01 | R$ 1.663.508,59 | 43.74% |
| 202301 | 494 | R$ 2.508.388,89 | R$ 1.092.305,23 | R$ 784.173,65 | 31.26% |
| 202302 | 510 | R$ 2.143.594,20 | R$ 1.134.160,50 | R$ 675.105,54 | 31.49% |
| 202303 | 502 | R$ 2.143.996,99 | R$ 1.121.925,87 | R$ 677.814,94 | 31.61% |
| 202304 | 493 | R$ 2.129.988,09 | R$ 1.098.311,12 | R$ 676.961,36 | 31.78% |
| 202305 | 488 | R$ 2.192.616,90 | R$ 1.092.059,93 | R$ 668.646,29 | 30.50% |
| 202306 | 482 | R$ 2.127.347,05 | R$ 1.072.836,05 | R$ 671.453,25 | 31.56% |
| 202307 | 485 | R$ 2.149.305,74 | R$ 1.087.134,27 | R$ 682.708,23 | 31.76% |
| 202308 | 497 | R$ 2.211.869,63 | R$ 1.105.849,27 | R$ 690.206,56 | 31.20% |
| 202309 | 508 | R$ 2.236.975,72 | R$ 1.123.253,89 | R$ 716.758,88 | 32.04% |
| 202310 | 510 | R$ 2.109.149,20 | R$ 1.126.343,17 | R$ 682.933,66 | 32.38% |
| 202311 | 506 | R$ 2.124.621,04 | R$ 1.116.711,21 | R$ 689.329,55 | 32.44% |
| 202312 | 994 | R$ 4.124.510,09 | R$ 2.205.185,13 | R$ 1.046.960,60 | 25.38% |
| 202401 | 561 | R$ 2.711.405,89 | R$ 1.314.774,11 | R$ 855.040,26 | 31.53% |
| 202402 | 514 | R$ 2.261.011,42 | R$ 1.197.518,64 | R$ 718.684,85 | 31.79% |
| 202403 | 551 | R$ 2.349.404,43 | R$ 1.297.602,08 | R$ 730.785,96 | 31.11% |
| 202404 | 509 | R$ 2.333.899,75 | R$ 1.179.914,20 | R$ 725.187,52 | 31.07% |
| 202405 | 500 | R$ 2.260.106,06 | R$ 1.161.497,04 | R$ 726.335,25 | 32.14% |
| 202406 | 495 | R$ 2.276.602,36 | R$ 1.150.418,57 | R$ 728.692,65 | 32.01% |
| 202407 | 501 | R$ 2.327.185,86 | R$ 1.156.254,03 | R$ 729.637,34 | 31.35% |
| 202408 | 498 | R$ 2.217.400,51 | R$ 1.149.814,80 | R$ 719.634,69 | 32.45% |
| 202409 | 496 | R$ 2.292.188,82 | R$ 1.147.827,47 | R$ 736.505,30 | 32.13% |
| 202410 | 496 | R$ 2.263.090,89 | R$ 1.148.576,98 | R$ 729.510,96 | 32.24% |
| 202411 | 497 | R$ 2.288.782,48 | R$ 1.151.604,42 | R$ 753.833,37 | 32.94% |
| 202412 | 965 | R$ 4.351.637,61 | R$ 2.250.439,28 | R$ 1.124.797,04 | 25.85% |
| 202501 | 503 | R$ 2.730.011,78 | R$ 1.192.964,97 | R$ 883.975,72 | 32.38% |
| 202502 | 494 | R$ 2.416.361,85 | R$ 1.221.116,18 | R$ 786.293,05 | 32.54% |
| 202503 | 511 | R$ 2.531.183,10 | R$ 1.248.010,84 | R$ 819.157,31 | 32.36% |
| 202504 | 492 | R$ 2.432.723,77 | R$ 1.208.799,61 | R$ 798.115,16 | 32.81% |
| 202505 | 485 | R$ 2.466.325,56 | R$ 1.196.478,53 | R$ 781.963,42 | 31.71% |
| 202506 | 480 | R$ 2.451.227,68 | R$ 1.184.404,12 | R$ 785.921,45 | 32.06% |
| 202507 | 478 | R$ 2.432.904,13 | R$ 1.186.448,21 | R$ 786.890,88 | 32.34% |
| 202508 | 480 | R$ 2.395.668,74 | R$ 1.183.232,18 | R$ 780.788,44 | 32.59% |
| 202509 | 473 | R$ 2.405.351,46 | R$ 1.166.688,93 | R$ 776.413,29 | 32.28% |
| 202510 | 470 | R$ 2.405.797,29 | R$ 1.164.923,98 | R$ 784.823,46 | 32.62% |
| 202511 | 465 | R$ 2.433.077,35 | R$ 1.155.452,01 | R$ 796.285,12 | 32.73% |
| 202512 | 914 | R$ 4.597.857,48 | R$ 2.279.966,14 | R$ 1.199.046,03 | 26.08% |

---

## 4. Candidatos de IRRF (motor de regras)

| Fornecedor | CNPJ | Competência | Status | Base | Retido | Confiança |
|---|---|---|---|---:|---:|---|
| Servicos Alfa Ltda | 11222333000181 | 2026-05 | `NEEDS_EVIDENCE` | R$ 10.000.000,00 | R$ 150.000,00 | LOW |
| Consultoria Gama SA | 99887766000155 | 2026-05 | `NEEDS_EVIDENCE` | R$ 2.000.000,00 | R$ 0,00 | LOW |

- **Servicos Alfa Ltda:** Destino do valor não comprovado. Bloquear validação de crédito.
- **Consultoria Gama SA:** Não houve retenção na fonte. Sem retenção comprovada não há crédito municipal com base no Tema 1.130 (Parecer SEI 480/2025/MF). Sem aliquota no documento: o ganho futuro nao foi estimado. A aliquota aplicavel precisa vir do documento (coluna ALIQUOTA ou taxa implicita) ou do decreto municipal.

**Crédito recuperável apurado: R$ 0,00.** Os dois registros vêm de uma planilha de retenção de maio/2026 sem alíquota e sem destino declarado — sem prova de destino (Tema 1.130; Parecer SEI 480/2025/MF) e sem alíquota, **não há crédito a reconhecer**. Isso é o produto funcionando como deve: **radar, não conclusão**.

---

## 5. O que a fonte pública prova e o que não prova

| Fonte | O que traz | O que **não** prova |
|---|---|---|
| Siconfi / DCA | IRRF retido, ISSQN arrecadado, despesas — por município e ano | Não prova retenção, destino financeiro, titularidade nem crédito |
| Portal da Transparência (folha) | Massa salarial, competências, 13º, descontos agregados | Não prova a composição das verbas (código de incidência por rubrica) nem a base de cálculo do INSS |
| CadPrev / RPPS | Quem é servidor e pensionista do regime | Não é a folha: não traz valores nem rubricas |
| EFD-Reinf / ECD / DARF / eSocial | Retenção, escrituração, recolhimento, folha por rubrica | **Documento autorizado** — é o que fecha a cadeia |

---

## 6. Pendências para fechar o diagnóstico

1. **EFD-Reinf** (ou planilha de retenções) por ano — para as retenções sobre serviços com alíquota e destino;
2. **eSocial da folha** (S-1000, S-1005, S-1010, S-1200, S-2299) — o motor rodou com o fixture sintético; a folha real permite apurar as teses (T006/T074/T010) com base e rubrica corretas;
3. **ECD e DARF** — conciliação: pago x declarado x apropriado;
4. **Decreto municipal vigente** — alíquotas por natureza (IN RFB 2.145/2023 + art. 7º-A) para a taxa do futuro decreto, alimentada pela taxa observada por ano.

---

## 7. Nota metodológica e proveniência

| Fonte | Endereço | Capturado em | SHA-256 (16) |
|---|---|---|---|
| Siconfi DCA | `https://apidatalake.tesouro.gov.br/ords/cdwhprd/siconfi/tt/dca?id_ente=3169604&an_exercicio={ano}` | 2026-10-26 | f53df344be054ce4 |
| Portal da Transparência (folha) | `https://transparencia.tupaciguara.mg.gov.br/publico/servidor?…&datAberturaInicio=2021-01-01&datAberturaFim=2025-12-31&codAdministracao=1` | 2026-10-26 | 36329efdd120af54 |
| Diagnóstico (motor) | Reversa Gov → Reversa Tax (revisão previdenciária) | 2026-10-26 | ed37c6676f654bcd |

- A folha pública é **dado pessoal no origem**: o que entra no Reversa é o **agregado por competência**. Nenhum nome, matrícula ou CPF é transportado.
- A DCA é **anual**: a série do Siconfi tem 1 ponto por ano de exercício, não 12 competências.
- Campo ausente é **desconhecido**, nunca zero. A taxa de 2022 (0,3334%) e a de 2024 (1,4283%) refletem a variação real do que foi retido — não um zero disfarçado.
- **Nenhum valor é reconhecido sem revisão humana.**

_Gerado por `tools/relatorio-tupaciguara.js` em 2026-10-26._