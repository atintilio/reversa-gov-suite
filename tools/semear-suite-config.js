// Semeia a configuracao de suite (suite_config) no banco.
//
// Uso:
//   POSTGRES_URL="..." SUITE_URL_GOV="https://..." SUITE_SHARED_SECRET="..." \
//     node tools/semear-suite-config.js
//
// O segredo nunca e passado por argumento (ficaria no historico do shell) nem
// gravado no repositorio: vem do ambiente, do cofre. A variavel de ambiente
// tem precedencia sobre o banco, entao semear aqui e o fallback para
// ambientes cuja configuracao nao pode ser mudada no deploy.
//
// Chaves:
//   SUITE_URL_GOV / SUITE_URL_TAX  -> suite.url_gov / suite.url_tax
//   SUITE_SHARED_SECRET            -> suite.secret_compartilhado
const postgres = require('postgres');

const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('POSTGRES_URL ou DATABASE_URL nao configurada');
  process.exit(1);
}

const sql = postgres(url, { max: 1, ssl: 'require', onnotice: () => {} });

const CHAVES = [
  ['SUITE_URL_GOV', 'suite.url_gov', 'URL da suite Reversa Gov (destino do handoff)'],
  ['SUITE_URL_TAX', 'suite.url_tax', 'URL da suite Reversa Tax (motor previdenciario)'],
  ['SUITE_SHARED_SECRET', 'suite.secret_compartilhado', 'Segredo compartilhado entre suites (HMAC do handoff e da integracao server-to-server)'],
];

async function main() {
  let semeados = 0;
  for (const [variavel, chave, descricao] of CHAVES) {
    const valor = process.env[variavel];
    if (!valor) { console.log(`${chave}: sem valor em ${variavel} — mantido o que existe`); continue; }
    await sql`
      insert into suite_config (key, value, description)
      values (${chave}, ${valor}, ${descricao})
      on conflict (key) do update set value = excluded.value, description = excluded.description, updated_at = now()`;
    console.log(`${chave}: gravado (${valor.length} caracteres — valor nao exibido)`);
    semeados++;
  }
  if (!semeados) console.log('nada semeado: nenhuma variavel informada');
}

main()
  .catch((erro) => { console.error('semear_suite_config_erro', erro.message); process.exitCode = 1; })
  .finally(() => sql.end({ timeout: 5 }));
