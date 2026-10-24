const { neon } = require('@neondatabase/serverless');
const postgres = require('postgres');

let cachedUrl = null;
let cachedSql = null;
let injected = null;

// Somente para testes automatizados: injeta um executor compatível com o tagged template do Neon.
function setSqlForTests(fn) { injected = fn; }

// O driver do Neon fala WebSocket com o proxy neon.tech. O banco do ambiente
// Gov e um Postgres comum (Supabase), alcancavel por TCP — usa-se o pacote
// postgres, que e o mesmo driver do runner de migrations do build. As duas APIs
// sao compativeis no tagged template: devolvem o array de linhas.
function criarDriver(url) {
  if (/^https?:/i.test(url) || /neon\.tech/i.test(url)) return neon(url);
  return postgres(url, { max: 1, ssl: sslDoPostgres(url), prepare: false, onnotice: () => {} });
}

// TLS e obrigatorio fora da maquina local; em localhost o teste de integracao
// usa um socket local sem certificado.
function sslDoPostgres(url) {
  return /^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost|\[::1\])/i.test(url) ? false : 'require';
}

function getSql() {
  if (injected) return injected;
  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_NOT_CONFIGURED');
  if (!cachedSql || cachedUrl !== url) {
    cachedSql = criarDriver(url);
    cachedUrl = url;
  }
  return cachedSql;
}

module.exports = { getSql, setSqlForTests, criarDriver, sslDoPostgres };
