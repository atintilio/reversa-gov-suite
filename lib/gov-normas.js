// Reversa Gov — camada normativa.
//
// Reúne as fontes que sustentam o módulo, para que nenhum número, codigo ou
// prazo saia da memoria. Cada item aponta a norma de origem.
//
// Fontes:
//   - CF/88, arts. 157, I e 158, I
//   - STF, RE 1.293.453/RS, Tema 1.130 (julgado em 11/10/2021)
//   - STF, RE 1.346.152, Tema 1.217 (teto da correcao: Selic)
//   - Parecer SEI 5744/2022/ME (PGFN, 14/04/2022) — consequente do Tema 1.130
//   - Parecer SEI 480/2025/MF (consulta da RFB respondida pela PGFN)
//   - IN RFB 2.145/2023 (arts. 2-A, 3-A, 5-A, 7-A, 37 §4º e Anexo I)
//   - MAFON 2025 (RFB), secao "Retencao do IR sobre rendimentos pagos por
//     orgaos e entidades da administracao publica estadual, distrital ou
//     municipal a outras pessoas juridicas"
//   - MCASP 11a edicao, item 3.6.2 (IRRF dos entes subnacionais)
//   - CTN, arts. 173 e 174 (decadencia e prescricao)

const NORMAS = {
  CF: 'CF/88, arts. 157, I e 158, I',
  TEMA_1130: 'STF, RE 1.293.453/RS, Tema 1.130 (julgado em 11/10/2021)',
  TEMA_1217: 'STF, RE 1.346.152, Tema 1.217 (teto da correcao: Selic)',
  PARECER_PGFN: 'Parecer SEI 5744/2022/ME (PGFN, 14/04/2022)',
  PARECER_MF: 'Parecer SEI 480/2025/MF',
  IN_2145: 'IN RFB 2.145/2023 (arts. 2-A, 3-A, 5-A, 7-A, 37 §4º e Anexo I)',
  MAFON: 'MAFON 2025 (RFB) — retencao do IR por entes subnacionais a PJ',
  MCASP: 'MCASP 11a edicao, item 3.6.2',
  CTN: 'CTN (Lei 5.172/1966), arts. 173 e 174',
};

// Naturezas de receita da DCA/PCASP usadas na triagem (prefixo RO na DCA).
// O MCASP 3.6.2 orienta o município a contabilizar a retencao como receita
// tributaria, na natureza 1.1.1.3.03.1.0, porque o valor nao transita pela
// Uniao — fica direto com o ente arrecadador.
const NATUREZAS = {
  IRRF_TOTAL: '1.1.1.3.03.0.0',
  IRRF_TRABALHO: '1.1.1.3.03.1.0',
  IRRF_OUTROS: '1.1.1.3.03.4.0',
  RECEITAS_CORRENTES: '1.1.0.0.00.0.0',
};

// Codigos de receita da RFB usados na declaracao.
// 6256 e o codigo que os entes subnacionais usam na EFD-Reinf e na DIRF
// para o IRRF de que trata o art. 2-A da IN 2.145/2023.
const CODIGOS = {
  IRRF_ENTES_SUBNACIONAIS: '6256',
  IRRF_DARF: '0561',
};

// Faixa de aliquota para servico na IN RFB 2.145/2023 (Anexo I, coluna
// 02-IR). As aliquotas de 1,5% e 1% citadas no MAFON sao as antigas,
// afastadas pelo criterio da especialidade apos o Tema 1.130.
const ALIQUOTAS = {
  SERVICO_MIN: 0.012,
  SERVICO_MAX: 0.048,
  FAIXA_TEXTO: '1,2% a 4,8% (IN RFB 2.145/2023, Anexo I)',
  OBS: 'As aliquotas de 1,5% e 1% sao as antigas, afastadas pelo criterio da especialidade apos o Tema 1.130 (MAFON, item 6.a).',
};

// Prazos: 5 anos para construir o credito e 5 para cobrar.
const PRAZO = {
  DECADENCIA_ANOS: 5,
  PRESCRICAO_ANOS: 5,
  JANELA_ANOS: 10,
  TEXTO: '5 anos de decadencia (art. 173 do CTN) + 5 de prescricao (art. 174): janela de 10 anos.',
};

// Atualizacao: o Tema 1.217 limita a correcao a taxa Selic.
const ATUALIZACAO = {
  INDICE: 'Selic',
  TEXTO: 'A correcao monetaria nao pode exceder a taxa Selic (Tema 1.217).',
};

// Texto de apoio, usado na metodologia do diagnostico.
const FUNDAMENTO = [
  'Pertence ao municipio a titularidade do IRRF retido sobre pagamentos a pessoas juridicas (Tema 1.130; CF, arts. 157, I e 158, I).',
  'A retencao do ente subnacional e declarada na EFD-Reinf com o codigo 6256, na propria origem (IN RFB 2.145/2023, art. 7-A; MAFON, itens 2.1 e 3).',
  'Se o municipio reteve e repassou a Uniao sem se apropriar, ha credito a pleitear (Parecer SEI 480/2025/MF).',
  'Nao ha restituicao do que nao foi retido (Parecer SEI 480/2025/MF).',
  'O valor retido e contabilizado como receita tributaria do proprio ente, sem transito pela Uniao (MCASP 11a ed., item 3.6.2).',
];

module.exports = { NORMAS, NATUREZAS, CODIGOS, ALIQUOTAS, PRAZO, ATUALIZACAO, FUNDAMENTO };
