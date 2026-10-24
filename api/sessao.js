// Valida a sessao do cookie e responde 200 (valida) ou 401 (invalida).
// O middleware roda no edge e nao fala TCP com o Postgres, entao a consulta ao
// banco acontece aqui, em funcao Node. A regra e a mesma do middleware:
// cookie valido, sessao nao revogada, dentro da validade, com atividade nos
// ultimos 15 minutos e usuario ativo.
const crypto = require('node:crypto');
const { json } = require('../lib/http');
const { getSql } = require('../lib/db');

function cookieSession(req) {
  const raw = req.headers && req.headers.cookie ? String(req.headers.cookie) : '';
  const hit = raw.split(';').map((p) => p.trim()).find((p) => p.startsWith('rv_sessao='));
  return hit ? decodeURIComponent(hit.slice('rv_sessao='.length)) : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Método não permitido.' } });
  }
  const token = cookieSession(req);
  if (!token || !token.startsWith('s1.')) return json(res, 401, { ok: false });
  try {
    const sql = getSql();
    const digest = crypto.createHash('sha256').update(token).digest('hex');
    const rows = await sql`
      select s.id
      from auth_sessions s
      join users u on u.id = s.user_id
      where s.session_hash = decode(${digest}, 'hex')
        and s.revoked_at is null
        and s.expires_at > now()
        and coalesce(s.last_seen_at, s.created_at) > now() - interval '15 minutes'
        and u.status = 'active'
      limit 1`;
    return json(res, rows.length ? 200 : 401, { ok: !!rows.length });
  } catch (error) {
    console.error('sessao_erro', error.name || 'Error');
    return json(res, 503, { ok: false });
  }
};
