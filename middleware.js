import { neon } from '@neondatabase/serverless';

// APIs são tratadas por funções Node em /api. O middleware protege somente as páginas.
// A página inicial da marca (/) fica de fora do portão; o Reversa Gov (/gov.html) continua
// atrás do login, como as demais páginas internas da plataforma.
// /assets/ e o favicon ficam públicos porque a landing da marca os carrega antes de qualquer login.
// "entrar" e a entrada por passagem de sessao (handoff): precisa ficar fora do portao,
// senao o middleware devolveria o usuario ao login antes de a suite validar o token.
// A rota em si exige um token assinado de vida curta -- o portao nao e a protecao dela.
// O "$" isenta a raiz: sem ele, "/" casaria com o grupo e cairia no redirecionamento para /login.html.
export const config = { matcher: '/((?!login\\.html|reset-password\\.html|aprovacao\\.html|aprovacao\\.js|validacao-contador\\.html|validacao-contador\\.js|assets/|favicon\\.ico|favicon\\.png|robots\\.txt|api/|entrar|index\\.html|$).*)' };

const COOKIE = 'rv_sessao';
const enc = new TextEncoder();
const edgeSql = process.env.POSTGRES_URL ? neon(process.env.POSTGRES_URL) : null;

function cookies(req) {
  const out = {};
  (req.headers.get('cookie') || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

async function sha256Hex(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(value))));
  return Array.from(bytes).map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function dbSessionValid(token) {
  if (!edgeSql || !token || !token.startsWith('s1.')) return false;
  try {
    const digest = await sha256Hex(token);
    const rows = await edgeSql`
      select s.id
      from auth_sessions s
      join users u on u.id = s.user_id
      where s.session_hash = decode(${digest}, 'hex')
        and s.revoked_at is null
        and s.expires_at > now()
        and coalesce(s.last_seen_at, s.created_at) > now() - interval '15 minutes'
        and u.status = 'active'
      limit 1`;
    return rows.length > 0;
  } catch (error) {
    console.error('middleware_database_error', error.name || 'Error');
    return false;
  }
}

// Mesma regra de lib/security.js: sem segredo literal e com data de desligamento do legado.
function legacyEnabled() {
  const flag = String(process.env.LEGACY_AUTH_UNTIL || 'off').trim().toLowerCase();
  if (flag === 'off' || flag === 'false' || flag === '0') return false;
  const until = new Date(`${flag}T23:59:59-03:00`);
  if (Number.isNaN(until.getTime()) || Date.now() > until.getTime()) return false;
  return Boolean(process.env.REVERSA_USERS) && Boolean(process.env.REVERSA_SECRET || process.env.SESSION_SECRET);
}

async function legacyKey() {
  const users = process.env.REVERSA_USERS || '';
  const secret = process.env.REVERSA_SECRET || process.env.SESSION_SECRET;
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${users}|${secret}`));
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function legacySign(value) {
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', await legacyKey(), enc.encode(value)));
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function legacySessionValid(token) {
  if (!token || token.startsWith('s1.') || !legacyEnabled()) return false;
  const last = token.lastIndexOf('~');
  const previous = token.lastIndexOf('~', last - 1);
  if (last < 0 || previous < 0) return false;
  const username = token.slice(0, previous);
  const expires = token.slice(previous + 1, last);
  const signature = token.slice(last + 1);
  if (!username || !(Number(expires) > Date.now())) return false;
  const expected = await legacySign(`${username}~${expires}`);
  return signature === expected;
}

function redirectLogin() {
  return new Response(null, { status: 303, headers: { Location: '/login.html', 'Cache-Control': 'no-store' } });
}

export default async function middleware(req) {
  const token = cookies(req)[COOKIE];
  if (await dbSessionValid(token) || await legacySessionValid(token)) return;
  return redirectLogin();
}
