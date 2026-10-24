const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const postgres = require('postgres');

// Runner com registro em schema_migrations (Tech Spec §8): versão + checksum, um arquivo por migration,
// cada arquivo em transação. Arquivo já aplicado com checksum diferente interrompe o build.
const DIR = path.join(__dirname, '..', 'db', 'migrations');

function splitStatements(content) {
  return content.split(/;\s*(?=\n|$)/).map((x) => x.trim()).filter((x) => x && !/^(--[^\n]*\n?)*$/.test(x));
}

function plan(applied, files) {
  const pending = [];
  for (const file of files) {
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, file))).digest('hex');
    const done = applied.get(file);
    if (done && done !== checksum) throw new Error(`MIGRATION_CHECKSUM_MISMATCH ${file}: crie uma nova migration em vez de alterar a aplicada`);
    if (!done) pending.push({ file, checksum });
  }
  return pending;
}

async function migrate(sql) {
  await sql.unsafe(`create table if not exists schema_migrations (
    version varchar(200) primary key,
    checksum varchar(64) not null,
    applied_at timestamptz not null default now()
  )`);
  const rows = await sql.unsafe('select version, checksum from schema_migrations');
  const applied = new Map(rows.map((r) => [r.version, r.checksum]));
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  const pending = plan(applied, files);
  for (const { file, checksum } of pending) {
    const statements = splitStatements(fs.readFileSync(path.join(DIR, file), 'utf8'));
    process.stdout.write(`${file}: ${statements.length} comandos\n`);
    await sql.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
      await tx.unsafe('insert into schema_migrations (version, checksum) values ($1, $2)', [file, checksum]);
    });
  }
  if (!pending.length) process.stdout.write('schema_migrations: nada pendente\n');
  return pending.map((p) => p.file);
}

async function main() {
  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('POSTGRES_URL ou DATABASE_URL não configurada');
  const local = /^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost|\[::1\])/i.test(url);
  const sql = postgres(url, { max: 1, ssl: local ? false : 'require', onnotice: () => {} });
  try { await migrate(sql); } finally { await sql.end({ timeout: 5 }); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { migrate, splitStatements, plan };
