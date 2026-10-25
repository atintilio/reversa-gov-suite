const { parseBody, redirect, method } = require('../lib/http');
const { authenticate, createSession, legacyCookie } = require('../lib/auth');
const { audit } = require('../lib/audit');
const { getSql } = require('../lib/db');
const { hit } = require('../lib/rate-limit');
const { normalizeEmail, hashSession } = require('../lib/security');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return method(res, ['POST']);
  const body = parseBody(req);
  // Destino pedido (o middleware leva para o login com ?next=): apos entrar,
  // o usuario volta para a pagina que pediu, nao para o inicio.
  const pedidoNext = String((req.query && req.query.next) || body.next || '').trim();
  const destino = pedidoNext.startsWith('/') && !pedidoNext.startsWith('//') ? pedidoNext : '/ambiente.html';
  const identifier = body.usuario || body.email || '';
  const password = body.senha || body.password || '';
  let result;
  try {
    const sql = getSql();
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    const byIp = await hit(sql, `login:ip:${hashSession(ip)}`, 60);
    const byAccount = await hit(sql, `login:account:${hashSession(normalizeEmail(identifier))}`, 20);
    if (byIp || byAccount) {
      await audit('auth.login.rate_limited', { outcome: 'denied' });
      res.setHeader('Retry-After', '900');
      return redirect(res, '/login.html?erro=1');
    }
    result = await authenticate(identifier, password);
  } catch (error) {
    console.error('auth_login_database_error', error.name || 'Error');
    result = { kind: 'unavailable' };
  }
  if (result.kind === 'database') {
    try {
      const cookie = await createSession(result.user.id);
      await audit('auth.login.succeeded', { actorUserId: result.user.id, entityType: 'user', entityId: result.user.id, metadata: { method: 'database' } });
      return redirect(res, destino, { 'Set-Cookie': cookie });
    } catch (error) {
      console.error('auth_login_session_error', error.name || 'Error');
      return redirect(res, '/login.html?erro=config');
    }
  }
  if (result.kind === 'legacy') {
    await audit('auth.login.succeeded', { metadata: { method: 'legacy' } });
    return redirect(res, destino, { 'Set-Cookie': `rv_sessao=${encodeURIComponent(legacyCookie(result.username))}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax` });
  }
  await audit('auth.login.failed', { outcome: 'failure', metadata: { reason: result.kind === 'unavailable' ? 'unavailable' : 'invalid_credentials' } });
  await new Promise((resolve) => setTimeout(resolve, 500));
  return redirect(res, result.kind === 'unavailable' ? '/login.html?erro=config' : '/login.html?erro=1');
};
