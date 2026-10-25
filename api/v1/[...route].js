// Roteador único do domínio (/api/v1/*) — uma função serverless só, para caber no limite do plano Hobby.
// Toda rota autentica, resolve a organização do usuário e checa o papel no backend (Tech Spec §13).
const { parseBody, json, method } = require('../../lib/http');
const { context, can, permissions, HttpError } = require('../../lib/authz');
const { audit } = require('../../lib/audit');
const members = require('../../lib/domain/members');
const tax = require('../../lib/domain/tax');
const crm = require('../../lib/domain/crm');
const leidobem = require('../../lib/domain/leidobem');
const master = require('../../lib/domain/master');
const clientAuthorizations = require('../../lib/domain/client-authorizations');
const execucao = require('../../lib/domain/execucao');
const pgfn = require('../../lib/domain/pgfn');
const selicFontes = require('../../lib/selic-fontes');
const history = require('../../lib/domain/history');

function deny(ctx, permission, action) {
  if (can(ctx, permission)) return;
  audit('authz.denied', { outcome: 'denied', organizationId: ctx.organization.id, actorUserId: ctx.user.id, metadata: { action, role: ctx.role } });
  throw new HttpError(403, 'FORBIDDEN', 'Seu perfil não permite esta ação.');
}

function segments(req) {
  // Rotas de vários níveis chegam reescritas (vercel.json) com o caminho original em ?rvpath=.
  const rv = req.query && req.query.rvpath;
  const path = rv ? String(rv) : String(req.url || '').split('?')[0].replace(/^\/api\/v1\/?/, '');
  return path.split('/').filter(Boolean).map(decodeURIComponent);
}

function pdf(res, r) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${r.nome}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.end(r.pdf);
}

async function route(req, res) {
  const [resource, id, action] = segments(req);
  const m = req.method;
  const query = req.query || {};
  const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(m) ? parseBody(req) : {};
  // Exceção pública limitada a um snapshot: credencial aleatória do link, sem sessão da equipe.
  if (resource === 'client-approval' && !id) {
    if (m === 'GET') return json(res, 200, await clientAuthorizations.readPublic(req));
    if (m === 'POST') {
      const acao = body.action || 'assinar';
      if (acao === 'previa') return json(res, 200, await clientAuthorizations.previewPublic(req, body));
      if (acao === 'codigo') return json(res, 200, await clientAuthorizations.codePublic(req, body));
      if (acao === 'pdf') return pdf(res, await clientAuthorizations.pdfPublic(req, body));
      return json(res, 200, await clientAuthorizations.acceptPublic(req, body));
    }
    return method(res, ['GET', 'POST']);
  }
  // Página do contador: mesma lógica do link do cliente, com credencial própria.
  if (resource === 'accountant-review' && !id) {
    if (m === 'GET') return json(res, 200, await execucao.readAccountant(req));
    if (m === 'POST') return json(res, 200, await execucao.respondAccountant(req, body));
    return method(res, ['GET', 'POST']);
  }
  let ctx = await context(req);
  // Modo parceiro: a equipe Argus (master) opera dentro da organização de um parceiro (?parceiro= ou x-reversa-parceiro).
  // Para quem não é master o parâmetro é ignorado. O autor continua sendo o usuário logado.
  if (ctx.master && (resource === 'crm' || resource === 'cases')) ctx = await history.contextoParceiro(ctx, req, query, resource === 'cases' ? id : null);

  switch (resource) {
    case 'me':
      if (m !== 'GET') return method(res, ['GET']);
      return json(res, 200, { user: { name: ctx.user.name, email: ctx.user.email, legacy: ctx.user.legacy }, organization: ctx.organization, role: ctx.role, master: Boolean(ctx.master), permissions: permissions(ctx) });

    case 'members':
      deny(ctx, 'manageMembers', 'members');
      if (!id) {
        if (m === 'GET') return json(res, 200, { members: await members.list(ctx), mailConfigured: Boolean(process.env.MS_CLIENT_SECRET) });
        if (m === 'POST') return json(res, 201, await members.invite(ctx, body));
        return method(res, ['GET', 'POST']);
      }
      if (action === 'resend' && m === 'POST') return json(res, 200, await members.resend(ctx, id));
      if (!action && m === 'PATCH') { await members.update(ctx, id, body); return json(res, 200, { ok: true }); }
      if (!action && m === 'DELETE') { await members.remove(ctx, id); return json(res, 200, { ok: true }); }
      return method(res, ['PATCH', 'DELETE', 'POST']);

    case 'taxpayers':
      if (!id) {
        if (m === 'GET') return json(res, 200, { taxpayers: await tax.listTaxpayers(ctx, query) });
        if (m === 'POST') { deny(ctx, 'write', 'taxpayer.create'); return json(res, 201, await tax.createTaxpayer(ctx, body)); }
        return method(res, ['GET', 'POST']);
      }
      if (action === 'diagnostics' && m === 'GET') return json(res, 200, await tax.listDiagnostics(ctx, id));
      if (m === 'GET') return json(res, 200, await tax.getTaxpayer(ctx, id));
      if (m === 'PATCH') { deny(ctx, 'write', 'taxpayer.update'); await tax.updateTaxpayer(ctx, id, body); return json(res, 200, { ok: true }); }
      return method(res, ['GET', 'PATCH']);

    case 'cases':
      if (id && action === 'authorizations') {
        if (m === 'GET') return json(res, 200, await clientAuthorizations.list(ctx, id));
        if (m === 'POST') { deny(ctx, 'write', 'client.authorization.create'); return json(res, 201, await clientAuthorizations.create(ctx, id, body)); }
        return method(res, ['GET', 'POST']);
      }
      if (id && action === 'history') {
        if (m !== 'GET') return method(res, ['GET']);
        const h = await history.listar(ctx, id, query.limit);
        if (!h) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Caso não encontrado.' } });
        return json(res, 200, { historico: h });
      }
      if (id && action === 'restore') {
        if (m !== 'POST') return method(res, ['POST']);
        return json(res, 200, await tax.restoreCase(ctx, id));
      }
      if (id && !action && m === 'DELETE') {
        // Exclusão lógica: só a equipe Argus Prime; o parceiro pode editar, mas não excluir.
        if (!ctx.master) {
          audit('authz.denied', { outcome: 'denied', organizationId: ctx.organization.id, actorUserId: ctx.user.id, metadata: { action: 'case.delete', role: ctx.role } });
          throw new HttpError(403, 'FORBIDDEN', 'Somente a equipe Argus Prime pode excluir cards. Você pode editá-lo.');
        }
        return json(res, 200, await tax.archiveCase(ctx, id, body.motivo || query.motivo));
      }
      if (!id) {
        if (m === 'GET') return json(res, 200, await tax.listCases(ctx, query));
        if (m === 'POST') { deny(ctx, 'write', 'case.create'); return json(res, 201, await tax.createCase(ctx, body)); }
        return method(res, ['GET', 'POST']);
      }
      if (m === 'PATCH') { deny(ctx, 'write', 'case.update'); await tax.updateCase(ctx, id, body); return json(res, 200, { ok: true }); }
      return method(res, ['PATCH', 'DELETE']);

    case 'client-authorizations':
      if (id && m === 'DELETE') { deny(ctx, 'write', 'client.authorization.revoke'); return json(res, 200, await clientAuthorizations.revoke(ctx, id)); }
      if (id && action === 'contrato' && m === 'GET') return pdf(res, await clientAuthorizations.contractPdf(ctx, id));
      return method(res, ['DELETE']);

    case 'analyses':
      if (!id && m === 'POST') { deny(ctx, 'write', 'analysis.create'); return json(res, 201, await tax.saveAnalyses(ctx, body)); }
      if (id && action === 'review' && m === 'POST') { deny(ctx, 'review', 'analysis.review'); return json(res, 200, await tax.review(ctx, id, body)); }
      return method(res, ['POST']);

    case 'crm': {
      // /crm/pipeline · /crm/tasks · /crm/members · /crm/clients/:id[/cnpj|/agent] · /crm/contacts[/:id] · /crm/activities[/:id]
      const [, sub, sid, sact] = segments(req);
      if (sub === 'pipeline' && m === 'GET') return json(res, 200, await crm.pipeline(ctx, query));
      if (sub === 'tasks' && m === 'GET') return json(res, 200, await crm.tasks(ctx, query));
      if (sub === 'members' && m === 'GET') return json(res, 200, await crm.members(ctx));
      if (sub === 'clients' && sid && !sact && m === 'GET') return json(res, 200, await crm.client(ctx, sid));
      if (sub === 'clients' && sid && sact === 'report' && (m === 'GET' || m === 'POST')) {
        // POST leva o link de aprovação no corpo (o token nunca vai para a URL).
        const r = await crm.report(ctx, sid, query, m === 'POST' ? body : null);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${r.nome}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.end(r.pdf);
      }
      if (sub === 'clients' && sid && sact === 'enriquecer' && m === 'POST') { deny(ctx, 'write', 'crm.enriquecer'); return json(res, 200, await crm.enriquecerAgora(ctx, sid)); }
      if (sub === 'clients' && sid && sact === 'cnpj' && m === 'POST') { deny(ctx, 'write', 'crm.cnpj'); return json(res, 200, await crm.refreshCnpj(ctx, sid)); }
      if (sub === 'clients' && sid && sact === 'agent' && m === 'POST') { deny(ctx, 'write', 'crm.agent'); return json(res, 200, await crm.runAgent(ctx, sid, body)); }
      if (sub === 'contacts') {
        deny(ctx, 'write', 'crm.contact');
        if (!sid && m === 'POST') return json(res, 201, await crm.createContact(ctx, body));
        if (sid && m === 'PATCH') { await crm.updateContact(ctx, sid, body); return json(res, 200, { ok: true }); }
        if (sid && m === 'DELETE') { await crm.deleteContact(ctx, sid); return json(res, 200, { ok: true }); }
      }
      if (sub === 'activities') {
        deny(ctx, 'write', 'crm.activity');
        if (!sid && m === 'POST') return json(res, 201, await crm.createActivity(ctx, body));
        if (sid && m === 'PATCH') { await crm.updateActivity(ctx, sid, body); return json(res, 200, { ok: true }); }
        if (sid && m === 'DELETE') { await crm.deleteActivity(ctx, sid); return json(res, 200, { ok: true }); }
      }
      return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
    }

    case 'leidobem': {
      // /leidobem/casos · /leidobem/casos/:id · /leidobem/casos/:id/revisao · /leidobem/casos/:id/recibo
      const [, sub, sid, sact] = segments(req);
      if (sub !== 'casos') return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
      if (!sid && m === 'GET') return json(res, 200, await leidobem.list(ctx));
      if (!sid && m === 'POST') { deny(ctx, 'write', 'ldb.create'); return json(res, 201, await leidobem.create(ctx, body)); }
      if (sid && !sact && m === 'GET') return json(res, 200, await leidobem.get(ctx, sid));
      if (sid && !sact && m === 'PATCH') { deny(ctx, 'write', 'ldb.save'); return json(res, 200, await leidobem.save(ctx, sid, body)); }
      if (sid && sact === 'revisao' && m === 'POST') { deny(ctx, 'write', 'ldb.review'); return json(res, 200, await leidobem.review(ctx, sid, body)); }
      if (sid && sact === 'recibo' && m === 'POST') { deny(ctx, 'review', 'ldb.receipt'); return json(res, 200, await leidobem.receipt(ctx, sid, body)); }
      return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
    }

    case 'master': {
      // /master/resumo · /master/parceiros[/:id[/convite]] · /master/usuarios[/:id] · /master/carteira · /master/conflitos · /master/auditoria
      if (!ctx.master) {
        audit('authz.denied', { outcome: 'denied', organizationId: ctx.organization.id, actorUserId: ctx.user.id, metadata: { action: 'master', role: ctx.role } });
        throw new HttpError(403, 'FORBIDDEN', 'Acesso exclusivo do administrador master.');
      }
      const [, sub, sid, sact] = segments(req);
      if (sub === 'resumo' && m === 'GET') return json(res, 200, await master.resumo());
      if (sub === 'parceiros' && !sid && m === 'GET') return json(res, 200, { parceiros: await master.parceiros() });
      if (sub === 'parceiros' && !sid && m === 'POST') return json(res, 201, await master.criarParceiro(ctx, body));
      if (sub === 'parceiros' && sid && !sact && m === 'PATCH') return json(res, 200, await master.editarParceiro(ctx, sid, body));
      if (sub === 'parceiros' && sid && sact === 'convite' && m === 'POST') return json(res, 200, await master.reenviarConvite(ctx, sid));
      if (sub === 'usuarios' && !sid && m === 'GET') return json(res, 200, { usuarios: await master.usuarios() });
      if (sub === 'usuarios' && sid && m === 'PATCH') return json(res, 200, await master.editarUsuario(ctx, sid, body));
      if (sub === 'carteira' && m === 'GET') return json(res, 200, { clientes: await master.carteira(query) });
      if (sub === 'ranking' && m === 'GET') return json(res, 200, { ranking: await master.ranking({ dias: query.dias }) });
      if (sub === 'diagnosticos' && m === 'GET') return json(res, 200, { diagnosticos: await master.diagnosticos(query) });
      if (sub === 'alertas' && m === 'GET') return json(res, 200, { alertas: await require('../../lib/alertas').alertas(require('../../lib/db').getSql(), { orgId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(query.parceiro || '')) ? query.parceiro : null }) });
      if (sub === 'conflitos' && m === 'GET') return json(res, 200, { conflitos: await master.conflitos() });
      if (sub === 'auditoria' && m === 'GET') return json(res, 200, { eventos: await master.auditoria(query) });
      return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
    }

    case 'execucoes':
      // /execucoes · /execucoes/:id · /execucoes/:id/fase · /execucoes/:id/contador (só plataforma; aprovar e transmitir só master)
      if (!id) {
        if (m === 'GET') return json(res, 200, await execucao.list(ctx));
        if (m === 'POST') return json(res, 201, await execucao.start(ctx, body));
        return method(res, ['GET', 'POST']);
      }
      if (!action && m === 'GET') return json(res, 200, await execucao.get(ctx, id));
      if (!action && m === 'PATCH') return json(res, 200, await execucao.update(ctx, id, body));
      if (action === 'fase' && m === 'POST') return json(res, 200, await execucao.advance(ctx, id, body));
      if (action === 'contador' && m === 'POST') return json(res, 200, await execucao.sendAccountant(ctx, id, body));
      if (action === 'arquivos' && m === 'POST') return json(res, 200, await execucao.registerFiles(ctx, id, body));
      return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });

    case 'pgfn':
      // /pgfn · /pgfn/catalogo · /pgfn/simular (sem gravar) · /pgfn/:id · /pgfn/:id/dividas · /pgfn/:id/calcular · /pgfn/:id/rating · /pgfn/:id/revisao
      if (!id) {
        if (m === 'GET') return json(res, 200, await pgfn.list(ctx));
        if (m === 'POST') return json(res, 201, await pgfn.create(ctx, body));
        return method(res, ['GET', 'POST']);
      }
      if (id === 'catalogo' && m === 'GET') return json(res, 200, pgfn.catalogo());
      if (id === 'simular' && m === 'POST') return json(res, 200, await pgfn.simulate(ctx, body));
      if (!action && m === 'GET') return json(res, 200, await pgfn.get(ctx, id));
      if (!action && m === 'PATCH') return json(res, 200, await pgfn.saveFacts(ctx, id, body));
      if (action === 'dividas' && m === 'PUT') return json(res, 200, await pgfn.saveDebts(ctx, id, body));
      if (action === 'calcular' && m === 'POST') return json(res, 200, await pgfn.run(ctx, id));
      if (action === 'rating' && m === 'POST') return json(res, 200, await pgfn.rating(ctx, id, body));
      if (action === 'revisao' && m === 'POST') return json(res, 200, await pgfn.review(ctx, id, body));
      return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });

    case 'selic': {
      // Selic mensal para o diagnóstico PRELIMINAR (autenticado como as demais rotas). Cache 12 h no processo e na CDN.
      if (m !== 'GET') return method(res, ['GET']);
      const r = await selicFontes.obter();
      if (!r.ok) return json(res, 503, { error: { code: 'SELIC_UNAVAILABLE', message: 'Selic indisponível — valores sem atualização.' }, fontes: r.fontes });
      const { ok, ...dados } = r;
      return json(res, 200, dados, { 'Cache-Control': 's-maxage=43200, stale-while-revalidate=86400' });
    }

    case 'dashboard':
      if (m !== 'GET') return method(res, ['GET']);
      return json(res, 200, await tax.dashboard(ctx));

    case 'gov':
      return require('../../lib/domain/gov-routes')({ ctx, m, query, body, parts: segments(req), deny }, res);

    default:
      return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
  }
}

module.exports = async function handler(req, res) {
  try {
    await route(req, res);
  } catch (error) {
    if (error instanceof HttpError) return json(res, error.status, { error: { code: error.code, message: error.message } });
    console.error('api_v1_error', error.name || '', error.code || '', String(error.message || '').slice(0, 200), error.constraint || '');
    return json(res, 500, { error: { code: 'INTERNAL', message: 'Erro interno. Tente novamente.' } });
  }
};
