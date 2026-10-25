// Entrada por passagem de sessao (handoff) — a suite destino.
//
// O Reversa (suite de origem) verifica o acesso do membro e assina um token
// curto com os dados dele. Aqui a assinatura e conferida, o usuario e a
// organizacao sao garantidos no banco desta suite e a sessao e criada local:
// login unico, sem pedir senha de novo.
//
// O token e valido por 60 segundos e carrega os mesmos ids usados na origem, de
// modo que organizacao e Suite se referenciem igual nos dois lados.
const crypto = require('node:crypto');
const { parseBody, json, redirect, method } = require('../lib/http');
const { getSql } = require('../lib/db');
const { verificarSuiteTokenComQualquer } = require('../lib/suites');
const { randomToken, hashSession } = require('../lib/security');

async function garantirUsuario(sql, payload) {
  const email = String(payload.e || '').trim().toLowerCase();
  if (!email) throw new Error('TOKEN_SEM_EMAIL');
  const [existente] = await sql`select id, status from users where email_normalized = ${email} limit 1`;
  if (existente) {
    await sql`update users set name = coalesce(name, ${payload.n || email}), status = 'active' where id = ${existente.id}`;
    return existente.id;
  }
  const [novo] = await sql`
    insert into users (id, email, email_normalized, name, password_hash, status)
    values (${payload.u}, ${email}, ${email}, ${payload.n || email}, ${'!handoff'}, 'active')
    returning id`;
  return novo.id;
}

async function garantirVinculo(sql, payload, userId) {
  // Organizacao de destino. Se o usuario ja tem organizacao nesta suite
  // (bootstrap do owner, ou uma entrada anterior), e ela que vale: senao o
  // mesmo usuario ficaria com os dados partidos em duas organizacoes. Sem
  // vinculo, cria a organizacao com o id que veio da suite de origem, para a
  // identidade cross-suite.
  const [vinculo] = await sql`
    select organization_id from organization_members
    where user_id = ${userId} and status = 'active'
    order by created_at limit 1`;
  const orgId = vinculo ? vinculo.organization_id : payload.o;
  if (!vinculo) {
    await sql`
      insert into organizations (id, name, kind)
      values (${orgId}, ${payload.g || 'Reversa Gov'}, 'interna')
      on conflict (id) do nothing`;
  }
  await sql`
    insert into organization_members (organization_id, user_id, role, status)
    values (${orgId}, ${userId}, ${payload.r || 'viewer'}, 'active')
    on conflict (organization_id, user_id) do update set role = excluded.role, status = 'active', updated_at = now()`;
  await sql`
    insert into suite_access (organization_id, user_id, suite)
    values (${orgId}, ${userId}, 'gov')
    on conflict (organization_id, user_id, suite) do nothing`;
  return orgId;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return method(res, ['GET', 'POST']);
  const query = req.query || {};
  const body = parseBody(req);
  const token = query.token || body.token;
  if (!token) return json(res, 400, { error: { code: 'TOKEN_MISSING', message: 'Token de entrada ausente.' } });

  let payload;
  try {
    payload = verificarSuiteTokenComQualquer(token);
  } catch (error) {
    console.error('entrar_erro', error.name || 'Error');
    return json(res, 503, { error: { code: 'SUITE_NOT_CONFIGURED', message: 'Passagem de sessão não configurada.' } });
  }
  if (!payload) return json(res, 401, { error: { code: 'TOKEN_INVALID', message: 'Link de entrada inválido ou expirado. Volte ao Reversa e entre novamente.' } });

  try {
    const sql = getSql();
    const userId = await garantirUsuario(sql, payload);
    await garantirVinculo(sql, payload, userId);

    const raw = `s1.${randomToken(32)}`;
    await sql`
      insert into auth_sessions (user_id, session_hash, expires_at, created_at, last_seen_at)
      values (${userId}, decode(${hashSession(raw)}, 'hex'), now() + interval '12 hours', now(), now())`;
    const cookie = `rv_sessao=${encodeURIComponent(raw)}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax`;

    if (req.method === 'POST') return json(res, 200, { ok: true, url: '/gov.html' }, { 'Set-Cookie': cookie });
    res.setHeader('Set-Cookie', cookie);
    return redirect(res, '/gov.html');
  } catch (error) {
    console.error('entrar_falha', error.name || 'Error', String(error.code || ''));
    return json(res, 500, { error: { code: 'INTERNAL', message: 'Não foi possível concluir a entrada.' } });
  }
};
