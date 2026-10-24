// O middleware roda no edge, onde nao ha TCP para o Postgres. A validacao da
// sessao no banco e feita pela funcao Node /api/sessao, que aplica exatamente a
// mesma regra (cookie valido, sessao nao revogada, dentro da validade, com
// atividade nos ultimos 15 minutos e usuario ativo).
export const config = { matcher: '/((?!login\\.html|reset-password\\.html|aprovacao\\.html|aprovacao\\.js|validacao-contador\\.html|validacao-contador\\.js|assets/reversa-r\\.png|robots\\.txt|api/|favicon\\.ico).*)' };

const COOKIE = 'rv_sessao';

function cookies(req) {
  const out = {};
  (req.headers.get('cookie') || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

async function dbSessionValid(req, token) {
  if (!token || !token.startsWith('s1.')) return false;
  try {
    const res = await fetch(new URL('/api/sessao', req.url), {
      headers: { cookie: req.headers.get('cookie') || '' },
    });
    return res.status === 200;
  } catch (error) {
    console.error('middleware_sessao_error', error.name || 'Error');
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
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${users}|${secret}`));
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function legacySign(value) {
  const bytes = await crypto.subtle.sign('HMAC', await legacyKey(), new TextEncoder().encode(value));
  let binary = ''; for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
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
  if (await dbSessionValid(req, token) || await legacySessionValid(token)) return;
  return redirectLogin();
}
