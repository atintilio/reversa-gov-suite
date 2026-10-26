// Reversa Gov — normalizacao de periodo.
//
// A janela do modulo e a mesma em todas as fontes: 5 anos de exercicio.
// O periodo chega do usuario em formatos diferentes ("2021", "2021-01-01",
// {de, ate}) e cada adaptador precisa da mesma leitura. A conversao mora
// aqui para nao haver cinco interpretacoes de "de/ate" no codigo.
//
// "Ate" e INCLUSIVO: {de: '2021', ate: '2025'} cobre os exercicios de 2021 a
// 2025 (cinco anos).

const JANELA_PADRAO = 5;

function anoDe(valor) {
  if (valor == null) return null;
  const m = String(valor).match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

function anoAtual() {
  return new Date().getUTCFullYear();
}

/**
 * Lista de anos de exercicio do periodo.
 * @param {{de?:string, ate?:string, anos?:number[]}} periodo
 * @param {{janela?:number, ateAno?:number}} opcoes
 */
function anosDoPeriodo(periodo = {}, opcoes = {}) {
  if (Array.isArray(periodo.anos) && periodo.anos.length) {
    return [...new Set(periodo.anos.map(Number).filter((a) => Number.isInteger(a) && a > 1900))].sort();
  }
  const de = anoDe(periodo.de);
  const ate = anoDe(periodo.ate);
  if (de && ate && ate >= de) {
    const anos = [];
    for (let a = de; a <= ate; a++) anos.push(a);
    return anos;
  }
  if (de && !ate) return [de];
  if (!de && ate) return [ate];
  // Sem periodo: a janela padrao do modulo, terminando no ano corrente.
  const fim = opcoes.ateAno || anoAtual();
  const janela = opcoes.janela || JANELA_PADRAO;
  const anos = [];
  for (let a = fim - janela + 1; a <= fim; a++) anos.push(a);
  return anos;
}

/** Rotulo curto do periodo, usado como chave de idempotencia das capturas. */
function rotuloDoPeriodo(periodo = {}, opcoes = {}) {
  const anos = anosDoPeriodo(periodo, opcoes);
  if (!anos.length) return 'sem-periodo';
  if (anos.length === 1) return String(anos[0]);
  return `${anos[0]}-${anos[anos.length - 1]}`;
}

/** Data no formato YYYYMMDD (a API do PNCP usa data, sem separador). */
function dataCompacta(valor) {
  const m = String(valor || '').match(/^(\d{4})-?(\d{2})?-?(\d{2})?/);
  if (!m) return null;
  const ano = m[1];
  const mes = m[2] && m[2] !== '00' ? m[2] : '01';
  const dia = m[3] && m[3] !== '00' ? m[3] : '01';
  return `${ano}${mes}${dia}`;
}

/** Data no formato YYYY-MM-DD. */
function dataIso(valor) {
  const m = String(valor || '').match(/^(\d{4})-?(\d{2})?-?(\d{2})?/);
  if (!m) return null;
  return `${m[1]}-${m[2] || '01'}-${m[3] || '01'}`;
}

module.exports = { JANELA_PADRAO, anoDe, anosDoPeriodo, rotuloDoPeriodo, dataCompacta, dataIso, anoAtual };
