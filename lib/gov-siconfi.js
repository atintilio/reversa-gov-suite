// Reversa Gov — cliente do Siconfi (Tesouro Nacional), API de dados abertos.
//
// A DCA (Declaracao de Contas Anuais) e publica e traz o que o municipio
// DECLAROU ter arrecadado de IRRF e as suas despesas com pessoas juridicas.
// Isso permite a triagem sem depender de documento interno do municipio.
//
// API: https://apidatalake.tesouro.gov.br/ords/cdwhprd/siconfi/tt/
// Parametros: id_ente = codigo IBGE do ente; an_exercicio = ano da DCA.
// Limite da casa: 1 requisicao por segundo (respeitado aqui).

const BASE = 'https://apidatalake.tesouro.gov.br/ords/cdwhprd/siconfi/tt';

const { NATUREZAS } = require('./gov-normas');

const UA = 'ReversaGov/1.0 (consulta de dados publicos do Siconfi)';

// Contas da DCA que interessam ao modulo:
// - IRRF retido sobre pagamentos a pessoas juridicas ("IRRF - Outros")
// - IRRF do trabalho (folha) e o total, para nao misturar as naturezas
// - ISSQN arrecadado pelo municipio (imposto proprio, LC 116/2003)
// - Despesas com servicos de terceiros - PJ (a base de compras)
const CONTAS = {
  IRRF_TOTAL: `RO${NATUREZAS.IRRF_TOTAL}`,
  IRRF_TRABALHO: `RO${NATUREZAS.IRRF_TRABALHO}`,
  IRRF_OUTROS: `RO${NATUREZAS.IRRF_OUTROS}`,
  ISSQN: 'RO1.1.1.4.51.1.0',
  DESPESA_SERVICOS_PJ: 'DO3.3.90.39.00.00',
  DESPESA_CONSULTORIA: 'DO3.3.90.35.00.00',
  DESPESA_TOTAL: 'DO3.0.00.00.00.00',
};

const ROTULOS = {
  [CONTAS.IRRF_TOTAL]: 'IRRF retido na fonte (total)',
  [CONTAS.IRRF_TRABALHO]: 'IRRF retido na fonte - trabalho',
  [CONTAS.IRRF_OUTROS]: 'IRRF retido na fonte - outros (servicos a PJ)',
  [CONTAS.ISSQN]: 'ISSQN arrecadado (imposto proprio do municipio)',
  [CONTAS.DESPESA_SERVICOS_PJ]: 'Despesa com servicos de terceiros - PJ',
  [CONTAS.DESPESA_CONSULTORIA]: 'Despesa com servicos de consultoria',
  [CONTAS.DESPESA_TOTAL]: 'Despesa total',
};

let ultimaChamada = 0;
async function esperarTurno() {
  const agora = Date.now();
  const intervalo = 1100; // a casa pede 1 requisicao por segundo
  if (agora - ultimaChamada < intervalo) await new Promise((r) => setTimeout(r, intervalo - (agora - ultimaChamada)));
  ultimaChamada = Date.now();
}

async function chamar(caminho, params) {
  const url = new URL(BASE + caminho);
  Object.keys(params || {}).forEach((k) => { if (params[k] != null) url.searchParams.set(k, params[k]); });
  await esperarTurno();
  const resposta = await fetch(url.toString(), { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!resposta.ok) {
    const erro = new Error(`Siconfi respondeu ${resposta.status} para ${caminho}`);
    erro.status = resposta.status;
    throw erro;
  }
  return resposta.json();
}

// Cadastro dos entes (nome, CNPJ, codigo IBGE).
async function listarEntes() {
  const dados = await chamar('/entes', {});
  return (dados.items || []).map((e) => ({
    idEnte: e.cod_ibge,
    ente: e.ente,
    cnpj: e.cnpj,
    uf: e.uf,
    esfera: e.esfera,
    populacao: e.populacao,
  }));
}

// DCA de um ente em um exercicio.
async function buscarDca(idEnte, ano) {
  const dados = await chamar('/dca', { id_ente: idEnte, an_exercicio: ano });
  return dados.items || [];
}

// Extrai do conjunto bruto da DCA as contas que interessam.
// Para cada conta, guarda o maior valor encontrado entre as colunas
// (a DCA repete a conta por coluna/rotulo; o valor de interesse e o total).
//
// O ISSQN e casa por ROTULO, nao so por codigo: o Treasury mudou o codigo da
// conta ao longo dos exercicios (em 2021 o mesmo imposto veio em
// RO1.1.1.8.02.3.0; de 2022 em diante, RO1.1.1.4.51.1.0). Casar so pelo codigo
// transformaria um imposto declarado em "zero" — a regra do modulo e: campo
// ausente e desconhecido, nunca zero.
const ROTULO_ISSQN = /imposto sobre servi(c|ç)os de qualquer natureza/i;

function extrairContas(items) {
  const porConta = {};
  for (const item of items || []) {
    const codigo = item && item.cod_conta;
    const valor = item && item.valor;
    if (!codigo || valor == null) continue;
    const conhecido = CONTAS[Object.keys(CONTAS).find((k) => CONTAS[k] === codigo)];
    const issqnPorRotulo = ROTULO_ISSQN.test(String(item.conta || '')) ? 'ISSQN' : null;
    if (!conhecido && !issqnPorRotulo) continue;
    // A chave interna do ISSQN e o rotulo, para nao perder o codigo do ano.
    const chave = issqnPorRotulo ? `ISSQN:${codigo}` : codigo;
    if (!porConta[chave]) porConta[chave] = { codigo, descricao: item.conta, valor: 0, coluna: item.coluna, rotulo: item.rotulo, issqn: !!issqnPorRotulo };
    if (Number(valor) > Number(porConta[chave].valor)) {
      porConta[chave].valor = Number(valor);
      porConta[chave].coluna = item.coluna;
    }
  }
  return Object.values(porConta).map((c) => ({
    codigo: c.codigo,
    descricao: c.descricao,
    rotulo: c.issqn ? ROTULOS[CONTAS.ISSQN] : (ROTULOS[c.codigo] || c.descricao),
    valor: c.valor,
    coluna: c.coluna,
  }));
}

module.exports = { BASE, CONTAS, ROTULOS, listarEntes, buscarDca, extrairContas };
