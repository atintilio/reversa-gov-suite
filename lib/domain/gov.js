// Reversa Gov — domínio do módulo IRRF Municipal (isolado, aditivo).
// Casos de uso, consultas e validações de domínio.
// Nenhuma tabela existente é modificada; somente novas tabelas gov_*.

const { getSql } = require('../db');
const { audit } = require('../audit');
const { HttpError } = require('../authz');
const V = require('./gov-validation');

const STATUS_CANDIDATO = ['DRAFT', 'NEEDS_EVIDENCE', 'UNDER_REVIEW', 'VALIDATED', 'REJECTED', 'ON_HOLD'];
const DESTINO = ['PROVEN_MUNICIPAL', 'PROVEN_UNION', 'PROVEN_OTHER', 'DESTINATION_UNPROVEN'];
const STATUS_CASO = ['OPEN', 'DOCUMENTATION', 'LEGAL_REVIEW', 'READY_FOR_PROTOCOL', 'PROTOCOLLED', 'RECOVERED', 'CLOSED', 'REJECTED'];

async function listarMunicipios(ctx, query = {}) {
  const sql = getSql();
  const uf = query.uf ? V.text(query.uf, 'UF', 2).toUpperCase() : null;
  const busca = query.q ? V.text(query.q, 'Busca') : null;

  const rows = await sql`
    select id, ibge_code, name, state, cnpj_root, cnpj, status, created_at
    from gov_municipalities
    where organization_id = ${ctx.organization.id}
    order by name
  `;
  let municipios = rows.map((r) => ({
    id: r.id,
    ibgeCode: r.ibge_code,
    name: r.name,
    state: r.state,
    cnpjRoot: r.cnpj_root,
    cnpj: r.cnpj,
    status: r.status,
    createdAt: r.created_at,
  }));
  if (uf) municipios = municipios.filter((m) => m.state === uf);
  if (busca) {
    const q = busca.toLowerCase();
    municipios = municipios.filter((m) => m.name.toLowerCase().includes(q) || m.ibgeCode.includes(q) || m.state.toLowerCase().includes(q));
  }
  return { municipios };
}

async function criarMunicipio(ctx, body = {}) {
  const sql = getSql();
  const ibgeCode = V.text(body?.ibgeCode, 'IBGE', 7);
  const name = V.text(body?.name, 'Nome');
  const state = V.text(body?.state, 'UF', 2).toUpperCase();
  const cnpjRoot = body.cnpjRoot == null ? null : V.text(body.cnpjRoot, 'CNPJ raiz', 8);
  const cnpj = body.cnpj == null ? null : V.text(body.cnpj, 'CNPJ', 14).replace(/\D/g, '');
  if (!/^\d{7}$/.test(ibgeCode) || !V.UFS.has(state) || (cnpjRoot != null && !/^\d{8}$/.test(cnpjRoot))
    || (cnpj != null && !/^\d{14}$/.test(cnpj))) V.invalid('IBGE, UF, CNPJ ou CNPJ raiz inválido.');

  let row;
  try { row = (await sql`
    insert into gov_municipalities (organization_id, ibge_code, name, state, cnpj_root, cnpj)
    values (${ctx.organization.id}, ${ibgeCode}, ${name}, ${state}, ${cnpjRoot || null}, ${cnpj || null})
    returning id, ibge_code, name, state, cnpj_root, cnpj, status, created_at
  `)[0]; } catch (error) {
    if (error.code === '23505') throw new HttpError(409, 'DUPLICATE_MUNICIPALITY', 'Município já cadastrado nesta organização.');
    throw error;
  }

  await audit('gov.municipio.criado', {
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'gov_municipality',
    entityId: row.id,
    metadata: { ibgeCode: row.ibge_code, name: row.name },
  });

  return {
    id: row.id,
    ibgeCode: row.ibge_code,
    name: row.name,
    state: row.state,
    cnpjRoot: row.cnpj_root,
    cnpj: row.cnpj,
    status: row.status,
    createdAt: row.created_at,
  };
}

async function listarCandidatos(ctx, query = {}) {
  const sql = getSql();
  const status = query.status ? V.choice(query.status, STATUS_CANDIDATO, 'Status') : null;

  const rows = await sql`
    select c.id, c.entity_id, c.period, c.status, c.withheld_amount_cents,
           c.proven_destination_amount_cents, c.potential_amount_cents,
           c.confidence, c.legal_owner, c.cnr, c.updated_at,
           e.legal_name as entity_name, e.cnpj as entity_cnpj
    from gov_candidates c
    join gov_entities e on e.id = c.entity_id and e.organization_id = c.organization_id
    where c.organization_id = ${ctx.organization.id}
    order by c.updated_at desc
  `;
  let candidatos = rows.map((r) => ({
    id: r.id,
    entityId: r.entity_id,
    entityName: r.entity_name,
    entityCnpj: r.entity_cnpj,
    period: r.period,
    status: r.status,
    withheldAmountCents: Number(r.withheld_amount_cents),
    provenDestinationAmountCents: Number(r.proven_destination_amount_cents),
    potentialAmountCents: r.potential_amount_cents != null ? Number(r.potential_amount_cents) : null,
    confidence: r.confidence,
    legalOwner: r.legal_owner,
    cnr: r.cnr,
    updatedAt: r.updated_at,
  }));
  if (status) candidatos = candidatos.filter((c) => c.status === status);
  return { candidatos };
}

async function obterCandidato(ctx, id) {
  V.uuid(id);
  const sql = getSql();
  const rows = await sql`
    select c.*, e.legal_name as entity_name, e.cnpj as entity_cnpj, e.entity_type
    from gov_candidates c
    join gov_entities e on e.id = c.entity_id and e.organization_id = c.organization_id
    where c.id = ${id} and c.organization_id = ${ctx.organization.id}
  `;
  if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Candidato não encontrado.');

  const r = rows[0];

  const evidencias = await sql`
    select id, evidence_type, record_locator, validation_status, validated_by, validated_at, created_at
    from gov_evidence_links
    where candidate_id = ${id} and organization_id = ${ctx.organization.id}
    order by created_at desc
  `;

  return {
    id: r.id,
    entityId: r.entity_id,
    entityName: r.entity_name,
    entityCnpj: r.entity_cnpj,
    entityType: r.entity_type,
    period: r.period,
    status: r.status,
    grossCandidateAmountCents: Number(r.gross_candidate_amount_cents),
    withheldAmountCents: Number(r.withheld_amount_cents),
    provenDestinationAmountCents: Number(r.proven_destination_amount_cents),
    potentialAmountCents: r.potential_amount_cents != null ? Number(r.potential_amount_cents) : null,
    confidence: r.confidence,
    legalOwner: r.legal_owner,
    cnr: r.cnr,
    ruleId: r.rule_id,
    decisionReason: r.decision_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    evidencias: evidencias.map((e) => ({
      id: e.id,
      evidenceType: e.evidence_type,
      recordLocator: e.record_locator,
      validationStatus: e.validation_status,
      validatedBy: e.validated_by,
      validatedAt: e.validated_at,
      createdAt: e.created_at,
    })),
  };
}

async function criarCandidato(ctx, body = {}) {
  const sql = getSql();
  if (!body || typeof body !== 'object' || Array.isArray(body)) V.invalid('Corpo inválido.');
  const { entityId, period, status = 'DRAFT', grossCandidateAmountCents, withheldAmountCents,
    provenDestinationAmountCents, potentialAmountCents, confidence, legalOwner, cnr, ruleId } = body;

  if (!STATUS_CANDIDATO.includes(status)) {
    throw new HttpError(400, 'INVALID_STATUS', `Status inválido. Valores permitidos: ${STATUS_CANDIDATO.join(', ')}.`);
  }
  if (status === 'VALIDATED') V.invalid('Validação exige trilha de evidências e revisão humana.');
  V.uuid(entityId);
  V.period(period);
  for (const value of [grossCandidateAmountCents, withheldAmountCents, provenDestinationAmountCents, potentialAmountCents]) V.amount(value);
  V.choice(confidence, ['LOW', 'MEDIUM', 'HIGH', 'VERIFIED'], 'Confiança');
  V.choice(legalOwner, ['MUNICIPAL', 'FEDERAL', 'UNKNOWN'], 'Titularidade');
  const cnrValue = cnr == null ? null : V.text(cnr, 'CNR', 20);
  const ruleIdValue = ruleId == null ? null : V.text(ruleId, 'Regra', 240);
  const entity = await sql`select id from gov_entities where id = ${entityId} and organization_id = ${ctx.organization.id}`;
  if (!entity[0]) throw new HttpError(404, 'NOT_FOUND', 'Entidade não encontrada.');

  const row = (await sql`
    insert into gov_candidates (
      organization_id, entity_id, period, status,
      gross_candidate_amount_cents, withheld_amount_cents, proven_destination_amount_cents,
      potential_amount_cents, confidence, legal_owner, cnr, rule_id
    )
    values (
      ${ctx.organization.id}, ${entityId}, ${period || null}, ${status},
      ${grossCandidateAmountCents || 0}, ${withheldAmountCents || 0}, ${provenDestinationAmountCents || 0},
      ${potentialAmountCents ?? null}, ${confidence || null}, ${legalOwner || null}, ${cnrValue}, ${ruleIdValue}
    )
    returning id, status, created_at
  `)[0];

  await audit('gov.candidato.criado', {
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'gov_candidate',
    entityId: row.id,
    metadata: { entityId, period, status },
  });

  return {
    id: row.id,
    entityId,
    period,
    status: row.status,
    createdAt: row.created_at,
  };
}

async function dashboard(ctx) {
  const sql = getSql();
  const [row] = await sql`
    select (select count(*) from gov_municipalities where organization_id = ${ctx.organization.id}) as municipios,
      count(*) as candidatos,
      count(*) filter (where status = 'UNDER_REVIEW') as em_revisao,
      count(*) filter (where status = 'VALIDATED') as validados
    from gov_candidates where organization_id = ${ctx.organization.id}`;
  return { municipios: Number(row.municipios), candidatos: Number(row.candidatos),
    emRevisao: Number(row.em_revisao), validados: Number(row.validados) };
}

module.exports = {
  STATUS_CANDIDATO,
  DESTINO,
  STATUS_CASO,
  listarMunicipios,
  criarMunicipio,
  listarCandidatos,
  obterCandidato,
  criarCandidato,
  dashboard,
};
