// Verifica o caminho Postgres-over-TCP (o mesmo do Supabase) num Postgres real
// de teste: sobe um socket PGlite, aplica as migrations com o runner de build e
// exercita o runtime (lib/db.js) e a rota de sessao.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

const PORTA = 55432;
const URL_PG = `postgres://postgres:postgres@127.0.0.1:${PORTA}/postgres`;

let db; let server; let sql;

test.before(async () => {
  db = await PGlite.create();
  server = new PGLiteSocketServer({ db, port: PORTA, host: '127.0.0.1', maxConnections: 10 });
  await server.start();
  process.env.POSTGRES_URL = URL_PG;
  const postgres = require('postgres');
  sql = postgres(URL_PG, { max: 1, ssl: false, prepare: false, onnotice: () => {} });
});

test.after(async () => {
  if (server) await server.stop();
  if (db) await db.close();
});

test('o runner de build aplica as 15 migrations em Postgres por TCP', async () => {
  // Reproduz o runner (scripts/migrate.js) com a unica adaptacao do ambiente de
  // teste: PGlite nao tem a extensao pgcrypto (no Supabase ela existe). O
  // proprio helper de testes da plataforma faz a mesma skipped.
  const { splitStatements } = require('../scripts/migrate');
  const DIR = path.join(__dirname, '..', 'db', 'migrations');
  const arquivos = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  assert.equal(arquivos.length, 16);

  await sql.unsafe(`create table if not exists schema_migrations (
    version varchar(200) primary key, checksum varchar(64) not null, applied_at timestamptz not null default now())`);

  const aplicadas = [];
  for (const arquivo of arquivos) {
    const bruto = fs.readFileSync(path.join(DIR, arquivo), 'utf8');
    const checksum = crypto.createHash('sha256').update(bruto).digest('hex');
    const comandos = splitStatements(bruto).filter((c) => !/^(\s*--[^\n]*\n)*\s*create extension/i.test(c));
    await sql.begin(async (tx) => {
      for (const comando of comandos) await tx.unsafe(comando);
      await tx.unsafe('insert into schema_migrations (version, checksum) values ($1, $2)', [arquivo, checksum]);
    });
    aplicadas.push(arquivo);
  }
  assert.deepEqual(aplicadas, [
    '001_platform.sql', '002_org_cases_stage.sql', '003_owner_name.sql', '004_crm.sql',
    '005_lei_do_bem.sql', '006_client_authorizations.sql', '007_parceiros.sql',
    '008_visao_master.sql', '009_execucao.sql', '010_contratacao.sql', '011_pgfn.sql',
    '012_diagnosticos.sql', '013_case_history.sql', '014_gov.sql', '015_gov_tenant_integrity.sql',
    '016_suite_access.sql'
  ]);
  const tabelas = await sql`select table_name from information_schema.tables where table_schema = 'public' and table_name like 'gov_%' order by table_name`;
  assert.ok(tabelas.length >= 10, 'esperava as tabelas gov_*');
});

test('o runner real de build detecta as migrations pendentes e protege o checksum', async () => {
  const { plan } = require('../scripts/migrate');
  const DIR = path.join(__dirname, '..', 'db', 'migrations');
  const arquivos = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Map(arquivos.map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, f))).digest('hex')]));
  assert.deepEqual(plan(applied, arquivos), []);
  const adulterado = new Map(applied);
  adulterado.set('014_gov.sql', 'deadbeef');
  assert.throws(() => plan(adulterado, arquivos), /MIGRATION_CHECKSUM_MISMATCH/);
});

test('lib/db.js conversa por TCP: o runtime usa o mesmo Postgres do build', async () => {
  const { getSql, criarDriver } = require('../lib/db');
  assert.equal(typeof criarDriver(URL_PG), 'function');
  const runtime = getSql();
  const rows = await runtime`select count(*)::int as total from information_schema.tables where table_schema = 'public'`;
  assert.equal(Number(rows[0].total) > 0, true);
});

test('o dominio Gov roda sobre a conexao TCP: municipio e candidato', async () => {
  const { getSql } = require('../lib/db');
  const gov = require('../lib/domain/gov');
  const db = getSql();
  const [org] = await db`select id from organizations order by created_at limit 1`;
  const ctx = { organization: { id: org.id }, user: { id: org.id }, role: 'admin' };

  const municipio = await gov.criarMunicipio(ctx, { ibgeCode: '4205402', name: 'Florianópolis', state: 'SC' });
  assert.equal(municipio.name, 'Florianópolis');

  const [entidade] = await db`insert into gov_entities (organization_id, municipality_id, cnpj, legal_name, entity_type) values (${org.id}, ${municipio.id}, '11222333000181', 'Prefeitura', 'direct_admin') returning id`;
  const candidato = await gov.criarCandidato(ctx, { entityId: entidade.id, period: '2026-01-31', status: 'DRAFT', withheldAmountCents: 120000 });
  assert.equal(candidato.status, 'DRAFT');

  const lista = await gov.listarMunicipios(ctx, {});
  assert.equal(lista.municipios.length, 1);
  const painel = await gov.dashboard(ctx);
  assert.equal(painel.candidatos, 1);
});
