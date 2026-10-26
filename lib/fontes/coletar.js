// Reversa Gov — orquestrador de coleta de fontes publicas.
//
// Regras (do pacote de especificacao, 05_INGESTAO_E_PROVENIENCIA.md):
//  1. Registrar fonte, URL, orgao, termos, data e cobertura.
//  2. Capturar a resposta original e os metadados.
//  4. Calcular SHA-256 e classificar.
//  6. Marcar campos ausentes como desconhecidos, nunca como zero.
// 11. Rate limit e backoff por fonte.
// 12. Idempotencia: mesma fonte + mesmo periodo + mesmo hash nao duplica.
//
// E o que este modulo NAO faz: nao contorna login, captcha, paywall ou controle
// de acesso; nao interpreta a fonte como prova de retencao, destino,
// titularidade ou credito. Fonte publica e RADAR e CONTEXTO.

const crypto = require('crypto');
const { catalogo, porId } = require('./catalogo');
const adaptadores = require('./adaptadores');

// Espera entre requisicoes por fonte (o Siconfi, por exemplo, pede 1/s).
const esperaPorFonte = new Map();

function pausar(id, limite) {
  const intervalo = Math.max(1000, Math.round(1000 / Math.max(1, limite || 1)));
  const anterior = esperaPorFonte.get(id) || 0;
  const espera = Math.max(0, anterior + intervalo - Date.now());
  esperaPorFonte.set(id, Date.now() + espera);
  return espera;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/**
 * Coleta uma fonte. NUNCA lanca: devolve o registro do que aconteceu.
 * @param {{fonteId:string, municipioId?:string, periodo?:object, config?:object, opcoes?:object}} req
 */
async function coletarFonte(req) {
  const fonte = porId(req.fonteId);
  const inicio = new Date().toISOString();
  if (!fonte) {
    return {
      fonteId: req.fonteId, status: 'desconhecida', erro: 'Fonte fora do catalogo.', capturadoEm: inicio,
    };
  }
  const adaptador = adaptadores[fonte.adaptador];
  if (!adaptador) {
    return {
      fonteId: fonte.id, nome: fonte.nome, tier: fonte.tier, status: 'indisponivel',
      erro: `Adaptador "${fonte.adaptador}" nao implementado.`, capturadoEm: inicio,
    };
  }

  const espera = pausar(fonte.id, fonte.limite);
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));

  try {
    const bruto = await adaptador.coletar({ fonte, municipioId: req.municipalityId, periodo: req.periodo || {}, config: req.config || {}, opcoes: req.opcoes || {} });
    const conteudo = bruto && bruto.conteudo != null ? bruto.conteudo : null;
    const binario = conteudo != null && Buffer.isBuffer(conteudo) ? conteudo : (conteudo != null ? Buffer.from(String(conteudo), 'utf8') : null);
    const hash = binario ? sha256(binario) : null;
    return {
      fonteId: fonte.id,
      nome: fonte.nome,
      orgao: fonte.orgao,
      tier: fonte.tier,
      prova: fonte.prova,
      url: bruto && bruto.url ? bruto.url : fonte.urlBase,
      status: bruto && bruto.status ? bruto.status : 'ok',
      erro: bruto && bruto.erro ? bruto.erro : null,
      itens: bruto && bruto.itens != null ? bruto.itens : [],
      total: bruto && bruto.total != null ? bruto.total : (bruto && bruto.itens ? bruto.itens.length : 0),
      sha256: hash,
      mime: bruto && bruto.mime ? bruto.mime : (binario ? 'application/json' : null),
      bytes: binario ? binario.length : 0,
      resumo: bruto && bruto.resumo ? bruto.resumo : null,
      capturadoEm: new Date().toISOString(),
      duracaoMs: Date.now() - Date.parse(inicio),
    };
  } catch (erro) {
    // Falha de rede, WAF, formato mudado: registra e segue. Nunca "zero".
    return {
      fonteId: fonte.id, nome: fonte.nome, tier: fonte.tier, prova: fonte.prova,
      status: 'indisponivel', erro: String(erro && erro.message ? erro.message : erro).slice(0, 300),
      itens: [], total: 0, sha256: null, mime: null, bytes: 0,
      capturadoEm: new Date().toISOString(), duracaoMs: Date.now() - Date.parse(inicio),
    };
  }
}

/**
 * Coleta um conjunto de fontes para um municipio.
 * @param {{municipioId?:string, uf?:string, fontes?:string[], config?:object, periodo?:object}} req
 */
async function coletarTodas(req) {
  const pedido = req || {};
  let lista = [];
  if (Array.isArray(pedido.fontes) && pedido.fontes.length) {
    lista = pedido.fontes.map((id) => porId(id)).filter(Boolean);
    if (!lista.length) {
      return { municipioId: pedido.municipioId || null, capturas: [], resumo: { total: 0, ok: 0, indisponivel: 0, desconhecida: pedido.fontes.length } };
    }
  } else {
    const c = catalogo;
    lista = c.fontesNacionais().concat(c.fontesEstaduais(pedido.uf), c.fontesMunicipais(pedido.config));
  }
  const capturas = [];
  for (const fonte of lista) {
    const cap = await coletarFonte({ fonteId: fonte.id, municipioId: pedido.municipioId, periodo: pedido.periodo, config: pedido.config });
    capturas.push(cap);
  }
  const resumo = {
    total: capturas.length,
    ok: capturas.filter((c) => c.status === 'ok').length,
    indisponivel: capturas.filter((c) => c.status === 'indisponivel').length,
    desconhecida: capturas.filter((c) => c.status === 'desconhecida').length,
    itens: capturas.reduce((s, c) => s + (c.total || 0), 0),
  };
  return { municipioId: pedido.municipioId || null, uf: pedido.uf || null, capturas, resumo };
}

module.exports = { coletarFonte, coletarTodas, sha256 };
