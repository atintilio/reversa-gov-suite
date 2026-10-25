// Reversa Gov — cliente do Reversa Tax para o diagnóstico previdenciário.
//
// A divisão é deliberate: o Tax tem o motor e as teses previdenciárias; o Gov
// tem a folha do município e fala com ele. A chamada é autenticada pelo mesmo
// token assinado de suite (SUITE_HMAC_SECRET) que já existe no handoff de
// login — as duas suites não dividem banco, mas dividem o segredo.
//
// Nada é inventado aqui: o Gov repassa os arquivos da folha como recebeu e
// devolve o que o Tax apurou, com a ressalva de estimativa do motor.

const { assinarSuiteToken, segredoSuite } = require('./suites');
const { HttpError } = require('./authz');

const TIMEOUT_MS = 120000; // a folha é pesada: o motor roda sobre os XMLs

function urlTax() {
  const base = process.env.SUITE_URL_TAX || process.env.TAX_BASE_URL;
  if (!base) throw new HttpError(503, 'TAX_NOT_CONFIGURED', 'Integração com o Reversa Tax não configurada neste ambiente.');
  return String(base).replace(/\/$/, '');
}

// Chama o diagnóstico no Tax. Devolve o corpo como veio, com a marca de
// origem: o número é do motor do Tax, não um cálculo do Gov.
async function diagnosticoPrevidenciario({ organizacao, municipio, arquivos, opcoes }) {
  if (!arquivos || !arquivos.length) throw new HttpError(400, 'NO_FILES', 'Nenhum arquivo de folha para enviar.');
  const token = assinarSuiteToken({
    op: 'previdenciario.diagnostico',
    o: organizacao || null,
    m: (municipio && municipio.ibge) || null,
    x: Math.floor(Date.now() / 1000) + 120,
  }, segredoSuite());

  let resposta;
  try {
    resposta = await fetch(`${urlTax()}/api/v1/previdenciario/diagnostico`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-reversa-suite-token': token },
      body: JSON.stringify({ organizacao, municipio, arquivos, ...(opcoes || {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (erro) {
    const msg = String(erro && erro.message || erro);
    if (/timeout|abort/i.test(msg)) throw new HttpError(504, 'TAX_TIMEOUT', 'O Reversa Tax não respondeu a tempo. Tente um lote menor de arquivos.');
    throw new HttpError(502, 'TAX_UNREACHABLE', 'Não foi possível falar com o Reversa Tax agora.');
  }

  const texto = await resposta.text();
  let corpo;
  try { corpo = JSON.parse(texto || '{}'); } catch { corpo = {}; }

  if (!resposta.ok) {
    const erro = (corpo && corpo.error) || {};
    // Erro do Tax sobre a folha (formato, tamanho, escopo) volta como erro
    // do Gov com o mesmo código: o usuário precisa saber o que corrigir.
    throw new HttpError(resposta.status, erro.code || 'TAX_ERROR', erro.message || 'O Reversa Tax recusou a folha.');
  }
  return corpo;
}

module.exports = { diagnosticoPrevidenciario, urlTax, TIMEOUT_MS };
