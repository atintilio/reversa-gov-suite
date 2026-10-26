// Reversa Gov — utilidades de rede para os adaptadores de fontes publicas.
//
// Regras desta camada:
//  - Nunca contorna login, captcha, paywall ou controle de acesso. Se a
//    resposta vier como pagina de login ou HTML, o erro diz isso — o
//    adaptador registra "indisponivel" com o motivo.
//  - Timeo curto: fonte publica que nao responde nao pode travar a coleta.
//  - User-Agent identificavel: quem mantem a API precisa saber quem esta
//    consumindo.

const UA = 'ReversaGov/1.0 (coleta de dados publicos)';

const TIMEOUT_PADRAO = 20000;

function aguardar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Busca a URL e devolve o corpo como texto, o status HTTP e o content-type.
 * Lanca em caso de erro de rede ou de status fora de 2xx.
 */
async function buscar(url, { timeoutMs = TIMEOUT_PADRAO, accept = 'application/json', headers = {} } = {}) {
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), timeoutMs);
  try {
    const resposta = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept, ...headers },
      signal: controle.signal,
      redirect: 'follow',
    });
    const texto = await resposta.text();
    return {
      ok: resposta.ok,
      status: resposta.status,
      tipo: resposta.headers.get('content-type') || '',
      url: resposta.url || url,
      texto,
    };
  } catch (erro) {
    const motivo = erro && erro.name === 'AbortError'
      ? `tempo esgotado (${timeoutMs} ms)`
      : String((erro && erro.message) || erro);
    const falha = new Error(`Falha de rede em ${url}: ${motivo}`);
    falha.status = 0;
    falha.rede = true;
    throw falha;
  } finally {
    clearTimeout(relogio);
  }
}

/**
 * Busca a URL esperando JSON. Resposta que nao e JSON (pagina de login,
 * captcha, WAF) vira erro explicito — nunca um objeto vazio, que pareceria
 * "zero".
 */
async function buscarJson(url, opcoes = {}) {
  const resposta = await buscar(url, opcoes);
  if (resposta.status === 204 || !resposta.texto.trim()) {
    return { dados: null, vazio: true, status: resposta.status, url: resposta.url, tipo: resposta.tipo };
  }
  if (!resposta.ok) {
    const erro = new Error(`HTTP ${resposta.status} em ${url}`);
    erro.status = resposta.status;
    erro.corpo = String(resposta.texto || '').slice(0, 300);
    throw erro;
  }
  const pareceJson = /^\s*[\[{]/.test(resposta.texto);
  if (/json/i.test(resposta.tipo) || pareceJson) {
    try {
      return { dados: JSON.parse(resposta.texto), vazio: false, status: resposta.status, url: resposta.url, tipo: resposta.tipo };
    } catch (erro) {
      const falha = new Error(`JSON invalido em ${url}: ${String(erro.message || erro).slice(0, 120)}`);
      falha.status = resposta.status;
      falha.naoJson = true;
      falha.corpo = String(resposta.texto || '').slice(0, 300);
      throw falha;
    }
  }
  const falha = new Error(`Resposta nao-JSON em ${url} (${resposta.tipo || 'sem content-type'}): `
    + `${String(resposta.texto || '').slice(0, 120).replace(/\s+/g, ' ')}`);
  falha.status = resposta.status;
  falha.naoJson = true;
  falha.corpo = String(resposta.texto || '').slice(0, 300);
  throw falha;
}

/** Junta parametros de query ignorando os vazios. */
function query(params) {
  const partes = [];
  for (const [chave, valor] of Object.entries(params || {})) {
    if (valor == null || valor === '') continue;
    partes.push(`${encodeURIComponent(chave)}=${encodeURIComponent(valor)}`);
  }
  return partes.length ? `?${partes.join('&')}` : '';
}

module.exports = { UA, TIMEOUT_PADRAO, aguardar, buscar, buscarJson, query };
