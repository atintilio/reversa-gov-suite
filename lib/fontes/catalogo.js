// Reversa Gov — catalogo de fontes publicas.
//
// A premissa do modulo (05_INGESTAO_E_PROVENIENCIA.md do pacote de especificacao):
// as fontes publicas geram RADAR e CONTEXTO. Nao provam, sozinhas, retencao,
// destino financeiro, titularidade nem credito. Para isso, documento autorizado.
//
// A cobertura nao e uniforme no Brasil. Ha tres niveis, e cada um tem a sua
// propria geometria:
//
//   nacional  — a mesma API para todos os 5.570 municípios (Siconfi, CadPrev,
//               PNCP, TCU). Um adaptador por fonte, zero trabalho por município.
//   estadual  — um tribunal de contas por estado (CAPMG/MG, TCE-SP, TCE-PR...)
//               e o portal estadual. Adaptador por estado.
//   municipal — o portal da transparência de cada prefeitura: 5.570 portais,
//               de fornecedores e versões diferentes. Adaptador por plataforma,
//               com deteccao automatica e configuracao por municipio.
//
// Regra de ouro: uma fonte que nao responde e registrada como INDISPONIVEL,
// com o erro e a data. Nunca como "zero".

// O que a fonte prova, no limite do direito e do tecnico.
const PROVA = {
  RADAR: 'radar', // indica onde pode haver o problema; nao prova nada por si
  CONTEXTO: 'contexto', // numero declarado, para comparacao
  EVIDENCIA: 'evidencia', // documento oficial consultavel pelo cidadao
};

const TIER = { NACIONAL: 'nacional', ESTADUAL: 'estadual', MUNICIPAL: 'municipal' };

/**
 * Cada fonte declara:
 *  - id: identificador estavel (vai no banco e na proveniencia)
 *  - nome, orgao, urlBase
 *  - tier: nacional | estadual | municipal
 *  - escopo: o que a fonte alcanca
 *  - prova: o limite do que ela prova (ver PROVA)
 *  - termos: licenca/termos de uso, quando conhecidos
 *  - limite: rate limit known (requisicoes por segundo)
 */
const CATALOGO = [
  {
    id: 'siconfi.dca',
    nome: 'Siconfi — DCA (Declaração de Contas Anuais)',
    orgao: 'Tesouro Nacional',
    urlBase: 'https://apidatalake.tesouro.gov.br/ords/cdwhprd/siconfi/tt',
    tier: TIER.NACIONAL,
    escopo: 'IRRF retido, ISSQN arrecadado e despesas com serviços, por município e por ano de exercício.',
    prova: PROVA.CONTEXTO,
    termos: 'API de dados abertos do Tesouro Nacional. Uso público; respeitar o limite de 1 requisição por segundo.',
    limite: 1,
    adaptador: 'siconfi',
  },
  {
    id: 'tcu.contasgoverno',
    nome: 'TCU — Contas do Governo',
    orgao: 'Tribunal de Contas da União',
    urlBase: 'https://contas.tcu.gov.br',
    tier: TIER.NACIONAL,
    escopo: 'Contas de governo municipais enviesadas ao TCU (exercício seguinte).',
    prova: PROVA.CONTEXTO,
    termos: 'Consulta pública do TCU. Não contorna login nem captcha.',
    limite: 1,
    adaptador: 'tcu',
  },
  {
    id: 'pncp.contratos',
    nome: 'PNCP — Portal Nacional de Contratos Públicos',
    orgao: 'Comprovante Nacional / Portal Nacional de Contratos Públicos',
    urlBase: 'https://pncp.gov.br',
    tier: TIER.NACIONAL,
    escopo: 'Contratos e atas de registro de preço do município: contexto de fornecedor e objeto.',
    prova: PROVA.CONTEXTO,
    termos: 'API pública do PNCP. Sem login para consulta.',
    limite: 1,
    adaptador: 'pncp',
  },
  {
    id: 'cadprev.cnps',
    nome: 'CadPrev — CNPS/CNFPS (servidores e pensionistas do RPPS)',
    orgao: 'Ministério da Previdência Social',
    urlBase: 'https://cadprev.previdencia.gov.br',
    tier: TIER.NACIONAL,
    escopo: 'Cadastro de servidores e pensionistas vinculados ao RPPS municipal: quantos são, de qual regime.',
    prova: PROVA.RADAR,
    termos: 'Consulta pública do CadPrev. Servidores são dados pessoais: entra só o agregado, nunca o CPF.',
    limite: 1,
    adaptador: 'cadprev',
  },
  {
    id: 'tce.capmg',
    nome: 'TCE-MG — CAPMG (folha de pagamento dos agentes públicos)',
    orgao: 'Tribunal de Contas de Minas Gerais',
    urlBase: 'https://capmg.tce.mg.gov.br',
    tier: TIER.ESTADUAL,
    uf: 'MG',
    escopo: 'Folha de pagamento dos agentes públicos do município, mês a mês — a base real do previdenciário.',
    prova: PROVA.CONTEXTO,
    termos: 'Consulta pública do TCEMG. Dado de remuneração de servidor: usar o agregado, não o individual.',
    limite: 1,
    adaptador: 'tce_estadual',
  },
  {
    id: 'portal.transparencia',
    nome: 'Portal da Transparência municipal — folha e servidores',
    orgao: 'Prefeitura',
    urlBase: null, // por município: http://<dominio>/ ou https://<dominio>/
    tier: TIER.MUNICIPAL,
    escopo: 'Folha de pagamento, servidores, despesas com pessoal e publicações oficiais do próprio município.',
    prova: PROVA.CONTEXTO,
    termos: 'Portal público do município. Sem login; não contorna captcha nem acesso restrito.',
    limite: 1,
    adaptador: 'portal_municipal',
  },
];

/** Fontes nacionais: valem para qualquer município, sem configuração. */
function fontesNacionais() { return CATALOGO.filter((f) => f.tier === TIER.NACIONAL); }

/** Fontes estaduais: filtered por UF. */
function fontesEstaduais(uf) { return CATALOGO.filter((f) => f.tier === TIER.ESTADUAL && (!uf || f.uf === uf)); }

/** Fontes municipais: uma por município, com a URL configurada. */
function fontesMunicipais(config) {
  return CATALOGO.filter((f) => f.tier === TIER.MUNICIPAL).map((f) => ({ ...f, urlBase: (config && config.portalUrl) || f.urlBase }));
}

function porId(id) { return CATALOGO.find((f) => f.id === id) || null; }

function todas() { return CATALOGO.slice(); }

module.exports = { CATALOGO, TIER, PROVA, fontesNacionais, fontesEstaduais, fontesMunicipais, porId, todas };
