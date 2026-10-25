// Reversa Gov — revisão previdenciária.
//
// A folha do município (eventos do eSocial) fica no Gov. Quem apura as teses
// é o Reversa Tax, que tem o motor e as teses; o Gov envia a folha, recebe o
// resultado e guarda o registro da chamada.
//
// O que este módulo NÃO faz: somar a teses previdenciárias com os candidatos
// de IRRF. São naturezas diferentes — a do IRRF é receita do município, a
// previdenciária é custo do empregador — e a soma entre elas seria um erro
// metodológico. Por isso a revisão fica em painel próprio.
//
// E o que o número não é: estimativa. O motor declara pagamento
// 'nao-confirmado' e não atualiza pela Selic. Nada aqui vira crédito sem
// revisão humana.

const { getSql } = require('../db');
const { audit } = require('../audit');
const { HttpError } = require('../authz');
const V = require('./gov-validation');
const tax = require('../gov-tax');

const LIMITE_ARQUIVOS = 40;

// O Tax ja devolve em centavos (a fronteira entre suites e em centavos).
// Aqui e so conferir que o numero e inteiro e cabe em bigint.
function centavos(valor) {
  const n = Number(valor || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

// Documentos de folha já ingeridos pelo município (eventos do eSocial).
async function documentosDaFolha(sql, ctx, municipalityId) {
  return sql`
    select id, original_name, checksum_sha256, size_bytes, process_status, parsed_summary
    from gov_documents
    where organization_id = ${ctx.organization.id}
      and municipality_id = ${municipalityId}::uuid
      and parser_kind = 'esocial'
    order by received_at desc`;
}

/**
 * Envia a folha ao Reversa Tax e grava o que voltou.
 *
 * O município e os documentos são escolhidos aqui; oGov nao calcula nada:
 * o que chega do Tax e guardado como veio, com a versao do motor.
 */
async function revisar(ctx, body = {}) {
  const sql = getSql();
  const municipalityId = V.text(body.municipalityId, 'Município');
  const [municipio] = await sql`
    select id, name, ibge_code, cnpj from gov_municipalities
    where id = ${municipalityId}::uuid and organization_id = ${ctx.organization.id}
    limit 1`;
  if (!municipio) throw new HttpError(404, 'NOT_FOUND', 'Município não encontrado.');

  // Documentos: os que o usuário escolheu, ou todos os de folha do município.
  const escolhidos = Array.isArray(body.documentos) ? body.documentos.map(String) : null;
  const disponiveis = await documentosDaFolha(sql, ctx, municipio.id);
  const docs = (escolhidos
    ? disponiveis.filter((d) => escolhidos.includes(String(d.id)))
    : disponiveis).slice(0, LIMITE_ARQUIVOS);
  if (!docs.length) {
    throw new HttpError(400, 'NO_FOLHA', 'Nenhum evento de folha (eSocial) foi enviado para este município. Envie os arquivos de folha em Documentos antes de revisar.');
  }

  // O arquivo vai inteiro, como o município enviou: quem lê e apura é o Tax.
  const arquivos = [];
  for (const d of docs) {
    const [conteudo] = await sql`select content, content_text from gov_documents where id = ${d.id}::uuid`;
    if (!conteudo) continue;
    const buffer = Buffer.isBuffer(conteudo.content) ? conteudo.content : Buffer.from(String(conteudo.content || ''), 'utf8');
    const texto = conteudo.content_text || buffer.toString('utf8');
    arquivos.push({
      nome: d.original_name,
      texto: texto.slice(0, 3 * 1024 * 1024),
      contentBase64: buffer.toString('base64'),
    });
  }
  if (!arquivos.length) throw new HttpError(400, 'NO_FOLHA', 'Os arquivos de folha não puderam ser lidos.');

  const [run] = await sql`
    insert into gov_previdenciario_runs (
      organization_id, municipality_id, status, arquivos, documentos, requested_by
    ) values (
      ${ctx.organization.id}, ${municipio.id}, 'RUNNING', ${arquivos.length},
      ${docs.map((d) => d.id)}, ${ctx.user.id}
    )
    returning id`;

  // A auditoria da REVISAO sai depois do resultado do Tax: o evento
  // 'gov.previdenciario.revisao' com outcome 'success' significa que a
  // revisao terminou — e so termina se o Tax respondeu. Uma falha na
  // integracao e um 'failure', com o run marcado como ERROR.
  let resposta;
  try {
    resposta = await tax.diagnosticoPrevidenciario({
      organizacao: ctx.organization.id,
      municipio: { id: municipio.id, ibge: municipio.ibge_code, nome: municipio.name, cnpj: municipio.cnpj },
      arquivos,
    });
  } catch (erro) {
    await sql`
      update gov_previdenciario_runs
      set status = 'ERROR', erro = ${String(erro.message || erro).slice(0, 400)}
      where id = ${run.id}::uuid`;
    await audit('gov.previdenciario.revisao', {
      outcome: 'failure', organizationId: ctx.organization.id, actorUserId: ctx.user.id,
      entityType: 'gov_previdenciario_run', entityId: run.id,
      metadata: { municipio: municipio.name, arquivos: arquivos.length, erro: String(erro.message || erro).slice(0, 200) },
    });
    throw erro;
  }

  const teses = Array.isArray(resposta.teses) ? resposta.teses : [];
  const totalCents = centavos(resposta.total && resposta.total.valorCents);
  const totalNoPrazoCents = centavos(resposta.total && resposta.total.valorNoPrazoCents);

  await sql`delete from gov_previdenciario_teses where run_id = ${run.id}::uuid`;
  for (const t of teses) {
    await sql`
      insert into gov_previdenciario_teses (
        organization_id, run_id, municipality_id, tese_id, nome,
        base_cents, base_no_prazo_cents, valor_cents, valor_no_prazo_cents,
        competencias, condicional, documento_id, observacao
      ) values (
        ${ctx.organization.id}, ${run.id}::uuid, ${municipio.id}, ${t.id}, ${t.nome || null},
        ${centavos(t.baseCents)}, ${centavos(t.baseNoPrazoCents)}, ${centavos(t.valorCents)}, ${centavos(t.valorNoPrazoCents)},
        ${Number(t.competencias || 0)}, ${Boolean(t.condicional)}, ${docs[0] ? docs[0].id : null},
        ${t.condicao ? String(t.condicao).slice(0, 400) : null}
      )`;
  }

  await sql`
    update gov_previdenciario_runs
    set status = 'OK', engine_version = ${String(resposta.motor && resposta.motor.versao || '').slice(0, 20)},
        engine_version_extra = ${String(resposta.motor && resposta.motor.versaoExtra || '').slice(0, 20)},
        teses_count = ${teses.length}, total_cents = ${totalCents}, total_no_prazo_cents = ${totalNoPrazoCents},
        resultado = ${JSON.stringify({
          avisos: resposta.avisos || [],
          requerDocumento: resposta.requerDocumento || [],
          dependencias: resposta.dependencias || [],
          escopo: resposta.escopo || null,
          rescisoes: resposta.rescisoes || null,
          inssSegurado: resposta.inssSegurado || null,
          pagamento: resposta.pagamento || 'nao-confirmado',
          rubricasAnalisadas: resposta.rubricasAnalisadas || 0,
          motor: resposta.motor || null,
        })}::jsonb
    where id = ${run.id}::uuid`;

  // A revisao terminou: o Tax respondeu e as teses foram gravadas.
  await audit('gov.previdenciario.revisao', {
    outcome: 'success', organizationId: ctx.organization.id, actorUserId: ctx.user.id,
    entityType: 'gov_previdenciario_run', entityId: run.id,
    metadata: { municipio: municipio.name, arquivos: arquivos.length, teses: teses.length },
  });

  return {
    runId: String(run.id),
    status: 'OK',
    municipio: { id: String(municipio.id), nome: municipio.name, ibge: municipio.ibge_code },
    motor: resposta.motor || null,
    total: { valorCents: totalCents, valorNoPrazoCents: totalNoPrazoCents },
    teses: teses.map((t) => ({
      id: t.id, nome: t.nome, baseCents: centavos(t.baseCents), valorCents: centavos(t.valorCents),
      valorNoPrazoCents: centavos(t.valorNoPrazoCents), competencias: t.competencias || 0, condicional: Boolean(t.condicional),
    })),
    avisos: resposta.avisos || [],
    requerDocumento: resposta.requerDocumento || [],
    ignorados: resposta.ignorados || [],
    ressalva: resposta.ressalva || 'Valores estimados. Revisão humana obrigatória antes de qualquer lançamento.',
  };
}

/**
 * Painel da revisão: a última apuração do município, as teses e o histórico.
 */
async function listar(ctx, query = {}) {
  const sql = getSql();
  const municipalityId = V.text(query.municipalityId, 'Município');
  const [mun] = await sql`
    select id, name from gov_municipalities
    where id = ${municipalityId}::uuid and organization_id = ${ctx.organization.id}
    limit 1`;
  if (!mun) throw new HttpError(404, 'NOT_FOUND', 'Município não encontrado.');

  const [ultimo] = await sql`
    select * from gov_previdenciario_runs
    where organization_id = ${ctx.organization.id} and municipality_id = ${mun.id}::uuid
    order by created_at desc limit 1`;
  const teses = ultimo ? await sql`
    select * from gov_previdenciario_teses
    where run_id = ${ultimo.id}::uuid
    order by valor_no_prazo_cents desc, valor_cents desc` : [];
  const historico = await sql`
    select id, status, engine_version, teses_count, total_cents, total_no_prazo_cents, created_at, erro
    from gov_previdenciario_runs
    where organization_id = ${ctx.organization.id} and municipality_id = ${mun.id}::uuid
    order by created_at desc limit 10`;
  const documentos = await sql`
    select id, original_name, size_bytes, process_status, received_at
    from gov_documents
    where organization_id = ${ctx.organization.id} and parser_kind = 'esocial' and municipality_id = ${mun.id}::uuid
    order by received_at desc limit 50`;

  return {
    run: ultimo ? {
      id: String(ultimo.id), status: ultimo.status,
      motor: { versao: ultimo.engine_version, versaoExtra: ultimo.engine_version_extra },
      arquivos: ultimo.arquivos, teses: ultimo.teses_count,
      totalCents: Number(ultimo.total_cents || 0),
      totalNoPrazoCents: Number(ultimo.total_no_prazo_cents || 0),
      criadoEm: ultimo.created_at,
      erro: ultimo.erro || null,
      resultado: ultimo.resultado || null,
    } : null,
    teses: teses.map((t) => ({
      id: String(t.id), teseId: t.tese_id, nome: t.nome,
      baseCents: Number(t.base_cents || 0), baseNoPrazoCents: Number(t.base_no_prazo_cents || 0),
      valorCents: Number(t.valor_cents || 0), valorNoPrazoCents: Number(t.valor_no_prazo_cents || 0),
      competencias: t.competencias, condicional: t.condicional, status: t.status,
      observacao: t.observacao || null,
    })),
    historico: historico.map((h) => ({
      id: String(h.id), status: h.status, motor: h.engine_version, teses: h.teses_count,
      totalCents: Number(h.total_cents || 0), criadoEm: h.created_at, erro: h.erro || null,
    })),
    documentos: documentos.map((d) => ({
      id: String(d.id), nome: d.original_name, bytes: Number(d.size_bytes || 0),
      status: d.process_status, recebidoEm: d.received_at,
    })),
    ressalva: 'Estimativa do motor previdenciário do Reversa Tax: pagamento não confirmado (GFIP/DCTFWeb/DARF) e valores não atualizados pela Selic. Não é crédito — revisão humana obrigatória.',
  };
}

module.exports = { revisar, listar, documentosDaFolha, LIMITE_ARQUIVOS };
