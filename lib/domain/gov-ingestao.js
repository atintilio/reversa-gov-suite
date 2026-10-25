// Reversa Gov — ingestao de documentos e diagnostico do modulo IRRF Municipal.
//
// Fluxo: documento (EFD-Reinf, ECD ou planilha) -> parser (lib/gov-parsers.js)
// -> fatos persistidos (entidades, pagamentos, retencoes, lancamentos) ->
// diagnostico: cada retencao e confrontada com a prova de destino e classificada
// pelo motor de regras (lib/domain/gov-irrf.js).
//
// Regra de ouro do modulo: nada vira "credito" sozinho. O diagnostico produz
// candidatos com a regra aplicada, o motivo e a evidencia que sustenta o
// caso; a validacao final e humana (gov_reviews).

const { getSql } = require('../db');
const { audit } = require('../audit');
const { HttpError } = require('../authz');
const V = require('./gov-validation');
const parsers = require('../gov-parsers');
const { classificarIrrf, REGRAS_IRRF } = require('./gov-irrf');

const TIPOS_EVIDENCIA = {
  efd_reinf: 'EFD_REINF',
  ecd: 'ECD',
  csv: 'PLANILHA_RETENCAO',
  pagamentos: 'RELATORIO_PAGAMENTOS',
};

const TIPOS_ENTIDADE = {
  municipio: 'direct_admin',
  autarquia: 'autarchy',
  fundacao: 'foundation',
  consorcio: 'consortium',
  outro: 'other',
};

// ------------------------------------------------------------- documentos

async function listarDocumentos(ctx, query = {}) {
  const sql = getSql();
  const municipioId = query.municipioId || null;
  const rows = await sql`
    select d.id, d.municipality_id, d.original_name, d.mime_type, d.size_bytes,
           d.checksum_sha256, d.classification, d.parser_kind, d.process_status,
           d.parsed_summary, d.period_label, d.error_message, d.received_at, d.created_at,
           m.name as municipality_name, m.ibge_code
    from gov_documents d
    left join gov_municipalities m on m.id = d.municipality_id
    where d.organization_id = ${ctx.organization.id}
      and (${municipioId}::uuid is null or d.municipality_id = ${municipioId}::uuid)
    order by d.created_at desc
    limit 200`;
  return {
    documentos: rows.map((d) => ({
      id: d.id,
      municipalityId: d.municipality_id,
      municipalityName: d.municipality_name || null,
      ibgeCode: d.ibge_code || null,
      name: d.original_name,
      mimeType: d.mime_type,
      sizeBytes: Number(d.size_bytes),
      checksum: d.checksum_sha256,
      classification: d.classification,
      parserKind: d.parser_kind,
      status: d.process_status,
      summary: d.parsed_summary || {},
      periodLabel: d.period_label,
      error: d.error_message,
      receivedAt: d.received_at,
      createdAt: d.created_at,
    })),
  };
}

function bytesDe(base64) {
  if (!base64) return Buffer.alloc(0);
  return Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
}

async function registrarDocumento(ctx, body = {}) {
  const sql = getSql();
  const nome = V.text(body.name, 'Nome do arquivo', 255);
  const municipalityId = V.text(body.municipalityId, 'Município');
  const mime = body.mimeType ? V.text(body.mimeType, 'Tipo', 120) : 'application/octet-stream';

  const [municipio] = await sql`
    select id from gov_municipalities
    where id = ${municipalityId}::uuid and organization_id = ${ctx.organization.id}
    limit 1`;
  if (!municipio) throw new HttpError(404, 'NOT_FOUND', 'Município não encontrado.');

  const conteudo = body.contentBase64 ? bytesDe(body.contentBase64) : Buffer.from(String(body.text || ''), 'utf8');
  if (!conteudo.length) throw new HttpError(400, 'EMPTY_FILE', 'O arquivo veio vazio.');
  if (conteudo.length > 20 * 1024 * 1024) throw new HttpError(413, 'FILE_TOO_LARGE', 'Arquivo acima de 20 MB.');

  const checksum = parsers.sha256(conteudo);
  // O tipo declarado pelo navegador nao e confiavel (muito arquivo chega como
  // octet-stream). O que decide e o conteudo: se nao ha byte nulo, e texto.
  const texto = semByteNulo(conteudo) ? conteudo.toString('utf8') : null;
  const parserKind = body.parserKind || parsers.detectarFormato(nome, texto || '');

  const [doc] = await sql`
    insert into gov_documents (
      organization_id, municipality_id, original_name, mime_type, size_bytes,
      checksum_sha256, classification, content, content_text, parser_kind,
      process_status, uploaded_by
    )
    values (
      ${ctx.organization.id}, ${municipio.id}, ${nome}, ${mime}, ${conteudo.length},
      ${checksum}, ${body.classification || 'internal'}, ${conteudo}, ${texto},
      ${parserKind}, 'PENDING', ${ctx.user.id}
    )
    returning id`;
  await audit('gov.documento.recebido', {
    organizationId: ctx.organization.id, actorUserId: ctx.user.id,
    entityType: 'gov_document', entityId: doc.id,
    metadata: { name: nome, parserKind, sizeBytes: conteudo.length },
  });
  return { id: doc.id, name: nome, parserKind, status: 'PENDING', checksum };
}

// Binario puro (PDF, imagem) fica guardado, mas sem parse. Texto plano e o
// caso comum: EFD-Reinf em .txt, planilha em .csv, DARF em .txt.
function semByteNulo(buf) {
  const amostra = buf.slice(0, 4096);
  if (!amostra.length) return false;
  for (const b of amostra) if (b === 0) return false;
  return !amostra.toString('utf8').includes('\uFFFD');
}

// ---------------------------------------------------------------- entidades

// Entidade do município: é o sujeito do diagnóstico e o pagador das
// retenções (o fornecedor fica nas colunas próprias de gov_payments).
// O CNPJ do município é o completo; quando o cadastro não tem CNPJ, usa-se
// um identificador derivado do código IBGE — sinal de que ainda falta o dado.
async function entidadeDoMunicipio(sql, ctx, municipio) {
  const [m] = await sql`select id, name, ibge_code, cnpj, cnpj_root from gov_municipalities where id = ${municipio.id}`;
  if (!m) return null;
  const cnpj = m.cnpj || (m.cnpj_root
    ? `${m.cnpj_root}000000`
    : `0${String(m.ibge_code).padStart(7, '0')}0000000`.slice(0, 14));
  const [existente] = await sql`select id from gov_entities where cnpj = ${cnpj} limit 1`;
  if (existente) {
    await sql`update gov_entities set municipality_id = ${municipio.id} where id = ${existente.id}`;
    return existente.id;
  }
  // Sem ON CONFLICT: a inferencia por coluna nao e confiavel em todo driver
  // (o ON CONFLICT precisa de um indice unico real). A corrida e tratada
  // naexception unica 23505.
  try {
    const [nova] = await sql`
      insert into gov_entities (organization_id, municipality_id, cnpj, legal_name, entity_type)
      values (${ctx.organization.id}, ${municipio.id}, ${cnpj}, ${m.name}, 'direct_admin')
      returning id`;
    return nova.id;
  } catch (error) {
    if (error.code !== '23505') throw error;
    const [outro] = await sql`select id from gov_entities where cnpj = ${cnpj} limit 1`;
    if (!outro) throw error;
    await sql`update gov_entities set municipality_id = ${municipio.id} where id = ${outro.id}`;
    return outro.id;
  }
}

// ----------------------------------------------------------------- processo

async function processarDocumento(ctx, id) {
  const sql = getSql();
  V.uuid(id);
  const [doc] = await sql`
    select * from gov_documents
    where id = ${id}::uuid and organization_id = ${ctx.organization.id}
    limit 1`;
  if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Documento não encontrado.');

  const texto = doc.content_text || (doc.content ? doc.content.toString('utf8') : '');
  let lido;
  try {
    if (doc.parser_kind === 'efd_reinf') lido = parsers.parseEfdReinf(texto);
    else if (doc.parser_kind === 'ecd') lido = parsers.parseEcd(texto, doc.original_name);
    else if (doc.parser_kind === 'csv') lido = parsers.parseCsvRetido(texto);
    else if (doc.parser_kind === 'pagamentos') lido = parsers.parseRelatorioPagamentos(texto);
    else throw new HttpError(400, 'UNKNOWN_FORMAT', 'Formato não reconhecido. Aceitos: EFD-Reinf, ECD, planilha de retenção ou relatório de pagamentos.');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    await sql`update gov_documents set process_status = 'ERROR', error_message = ${String(error.message || error).slice(0, 400)} where id = ${doc.id}`;
    throw new HttpError(500, 'PARSE_ERROR', 'Não foi possível ler o documento.');
  }

  const resumo = { tipo: lido.tipo, avisos: (lido.avisos || []).slice(0, 20) };
  let pagamentos = 0, retencoes = 0, entidades = 0, lancamentos = 0, remessas = 0;

  if (lido.tipo === 'efd_reinf') {
    const [municipio] = await sql`select id, name, ibge_code, cnpj, cnpj_root from gov_municipalities where id = ${doc.municipality_id}`;
    const entityId = await entidadeDoMunicipio(sql, ctx, municipio);
    // Os servicos tomados (registro 9) identificam o fornecedor; as retencoes
    // (registro 6) o valor retido e o CNR.
    const servicoPorChave = new Map((lido.servicos || []).map((s) => [`${s.grupo}|${s.pagamento}`, s]));
    const pagamentoPorChave = new Map((lido.pagamentos || []).map((p) => [`${p.grupo}|${p.pagamento}`, p]));

    for (const ret of (lido.retencoes || [])) {
      const k = `${ret.grupo}|${ret.pagamento}`;
      const serv = servicoPorChave.get(k);
      const pag = pagamentoPorChave.get(k);
      const fornecedor = serv && serv.prestador;
      const nome = null;
      const [pagamento] = await sql`
        insert into gov_payments (
          organization_id, entity_id, supplier_cnpj, supplier_name, payment_date, competence,
          gross_amount_cents, net_amount_cents, source_document_id, source_locator
        )
        values (
          ${ctx.organization.id}, ${entityId}, ${fornecedor || null}, ${nome},
          ${pag ? pag.data : null}, ${periodoDe(doc.period_label)},
          ${serv ? serv.valor : 0}, ${ret.withheldCents || 0},
          ${doc.id}, ${`EFD-Reinf registro 6 (linha ${ret.linha})`}
        )
        returning id`;
      await sql`
        insert into gov_withholdings (
          organization_id, payment_id, tax_type, tax_base_cents, rate,
          withheld_amount_cents, withholding_date, nature_code, cnr, legal_owner, source_document_id
        )
        values (
          ${ctx.organization.id}, ${pagamento.id}, 'IRRF', ${ret.baseCents || 0}, null,
          ${ret.withheldCents || 0}, ${pag ? pag.data : null}, null, ${ret.cnr || null},
          'UNKNOWN', ${doc.id}
        )`;
      pagamentos++;
      retencoes++;
    }
    resumo.retencoes = retencoes;
    resumo.pagamentos = pagamentos;
    resumo.fornecedores = new Set((lido.servicos || []).map((x) => x.prestador).filter(Boolean)).size;
    resumo.cnpjEstabelecimento = lido.cnpjEstabelecimento || null;
    resumo.linhasLidas = lido.linhasLidas || 0;
    if (cnpjEnte) resumo.cnpjEnte = cnpjEnte;
  } else if (lido.tipo === 'csv') {
    const [municipioCsv] = await sql`select id, name, ibge_code, cnpj, cnpj_root from gov_municipalities where id = ${doc.municipality_id}`;
    const entityId = await entidadeDoMunicipio(sql, ctx, municipioCsv);
    for (const r of (lido.registros || [])) {
      const [pagamento] = await sql`
        insert into gov_payments (
          organization_id, entity_id, supplier_cnpj, supplier_name, payment_date, competence,
          gross_amount_cents, net_amount_cents, source_document_id, source_locator
        )
        values (
          ${ctx.organization.id}, ${entityId}, ${r.cnpj}, ${r.razaoSocial || r.cnpj},
          ${r.dataPagamento}, ${primeiroDia(r.competencia)}, ${r.baseCents || 0},
          ${Math.max(0, (r.baseCents || 0) - (r.withheldCents || 0))},
          ${doc.id}, ${`Planilha linha ${r.linha}`}
        )
        returning id`;
      await sql`
        insert into gov_withholdings (
          organization_id, payment_id, tax_type, tax_base_cents, rate,
          withheld_amount_cents, withholding_date, nature_code, cnr, legal_owner, source_document_id
        )
        values (
          ${ctx.organization.id}, ${pagamento.id}, 'IRRF', ${r.baseCents || 0}, null,
          ${r.withheldCents || 0}, ${r.dataPagamento}, null, ${r.cnr || null},
          'UNKNOWN', ${doc.id}
        )`;
      pagamentos++;
      retencoes++;
    }
    resumo.registros = (lido.registros || []).length;
    resumo.pagamentos = pagamentos;
    resumo.retencoes = retencoes;
    resumo.fornecedores = new Set((lido.registros || []).map((r) => r.cnpj)).size;
  } else if (lido.tipo === 'pagamentos') {
    // Relatorio de pagamentos / DARF: prova o repasse a Uniao. Entra em
    // gov_remittances, que e o sinal de "repassou para a Uniao" no diagnostico.
    const [municipioPag] = await sql`select id, name, ibge_code, cnpj, cnpj_root from gov_municipalities where id = ${doc.municipality_id}`;
    const entityId = await entidadeDoMunicipio(sql, ctx, municipioPag);
    for (const rec of (lido.pagamentos || [])) {
      await sql`
        insert into gov_remittances (
          organization_id, entity_id, payment_reference, revenue_code, payment_date,
          amount_cents, recipient, source_document_id
        )
        values (
          ${ctx.organization.id}, ${entityId}, ${rec.numero}, ${rec.codigoReceita}, ${rec.data},
          ${rec.valorCents}, 'UNIAO (PGFN)', ${doc.id}
        )`;
      remessas++;
    }
    resumo.recolhimentos = remessas;
    resumo.pagamentos = remessas;
    resumo.totalRecolhidoCents = (lido.pagamentos || []).reduce((t, r) => t + r.valorCents, 0);
  } else if (lido.tipo === 'ecd') {
    // A ECD nao e um pagamento: sao lancamentos contabeis. Eles entram como
    // evidencia de destino (appropriacao ou repasse) nao como retencao.
    const [municipioEcd] = await sql`select id, name, ibge_code, cnpj, cnpj_root from gov_municipalities where id = ${doc.municipality_id}`;
    const entityId = await entidadeDoMunicipio(sql, ctx, municipioEcd);
    for (const l of (lido.lancamentos || [])) {
      await sql`
        insert into gov_accounting_entries (
          organization_id, entity_id, account_code, account_description, competence,
          debit_cents, credit_cents, journal_reference, source_document_id
        )
        values (
          ${ctx.organization.id}, ${entityId}, ${l.conta}, ${l.historico},
          ${competenciaDe(l.data)}, ${l.debitoCents}, ${l.creditoCents},
          ${l.numero}, ${doc.id}
        )`;
      lancamentos++;
    }
    resumo.lancamentos = lancamentos;
    resumo.cnpj = lido.cnpj || null;
    resumo.empresa = lido.empresa || null;
    resumo.competenciaInicio = lido.competenciaInicio || null;
    resumo.competenciaFim = lido.competenciaFim || null;
  }

  await sql`
    update gov_documents
    set process_status = 'DONE', parsed_summary = ${JSON.stringify(resumo)}::jsonb, error_message = null
    where id = ${doc.id}`;

  await audit('gov.documento.processado', {
    organizationId: ctx.organization.id, actorUserId: ctx.user.id,
    entityType: 'gov_document', entityId: doc.id,
    metadata: { tipo: lido.tipo, pagamentos, retencoes, lancamentos },
  });

  return { id: doc.id, status: 'DONE', tipo: lido.tipo, resumo };
}

// A competencia e um mes ("2026-05"); as colunas sao date.
function primeiroDia(competencia) {
  return competencia ? `${competencia}-01` : null;
}

// A competencia e coluna date: usa o primeiro dia do mes da data do lancamento.
function competenciaDe(data) {
  const d = parsers.dataBr(data);
  return d ? `${d.slice(0, 7)}-01` : null;
}
function periodoDe(label) {
  return label ? parsers.competencia(label) : null;
}

// --------------------------------------------------------------- diagnostico

// Heuristica de destino: procura nos lancamentos contabeis (ECD) mencoes a
// IRRF e, nas remessas, repasse a Uniao. Sao sinais — nunca conclusao.
async function sinaisDeDestino(sql, ctx, municipalityId, competencia) {
  // Apropriacao do IRRF pelo municipio: credito em conta de receita (4.x)
  // cujo historico cita IRRF. E sinal contavel, nao conclusao juridica.
  const [aprop] = await sql`
    select count(*)::int n, coalesce(sum(e.credit_cents), 0)::bigint total
    from gov_accounting_entries e
    join gov_documents d on d.id = e.source_document_id
    where e.organization_id = ${ctx.organization.id}
      and d.municipality_id = ${municipalityId}
      and (${competencia}::date is null or e.competence = ${competencia}::date)
      and e.account_code like '4%'
      and upper(coalesce(e.account_description, '') || ' ' || coalesce(e.account_code, '')) like '%IRRF%'`;
  const [remet] = await sql`
    select count(*)::int n, coalesce(sum(amount_cents), 0)::bigint total
    from gov_remittances r
    join gov_documents d on d.id = r.source_document_id
    where r.organization_id = ${ctx.organization.id}
      and d.municipality_id = ${municipalityId}
      and (${competencia}::date is null or to_char(r.payment_date, 'YYYY-MM') = left(${competencia}::text, 7))
      and upper(coalesce(r.recipient, '')) like any (array['%UNI%O%','%RECEITA FEDERAL%','%TESOURARIA NACIONAL%'])`;
  const [declarado] = await sql`
    select count(*)::int n
    from gov_declarations c
    join gov_documents d on d.id = c.source_document_id
    where c.organization_id = ${ctx.organization.id}
      and d.municipality_id = ${municipalityId}
      and (${competencia}::date is null or to_char(c.period, 'YYYY-MM') = left(${competencia}::text, 7))
      and c.destination_status in ('SENT_TO_UNION', 'RECOGNIZED')`;
  return {
    apropriadoCents: Number(aprop ? aprop.total : 0),
    lancamentosIrrf: aprop ? aprop.n : 0,
    remetidoCents: Number(remet ? remet.total : 0),
    remessasUniao: remet ? remet.n : 0,
    declaracoesDestino: declarado ? declarado.n : 0,
  };
}

async function executarDiagnostico(ctx, body = {}) {
  const sql = getSql();
  const municipalityId = body.municipalityId ? V.text(body.municipalityId, 'Município') : null;
  const municipios = await sql`
    select id, name, ibge_code, state from gov_municipalities
    where organization_id = ${ctx.organization.id}
      and (${municipalityId}::uuid is null or id = ${municipalityId}::uuid)
    order by name`;
  if (!municipios.length) throw new HttpError(404, 'NOT_FOUND', 'Nenhum município cadastrado.');

  const resultado = [];
  for (const mun of municipios) {
    resultado.push(await diagnosticoDoMunicipio(sql, ctx, mun));
  }
  await audit('gov.diagnostico.executado', {
    organizationId: ctx.organization.id, actorUserId: ctx.user.id,
    entityType: 'gov_municipality', entityId: municipalityId || null,
    metadata: { municipios: resultado.length },
  });
  return { diagnostico: resultado };
}

async function diagnosticoDoMunicipio(sql, ctx, mun) {
  const entityId = await entidadeDoMunicipio(sql, ctx, mun);

  // O diagnostico trabalha por PAGAMENTO (o fato economico), nao por retencao:
  // um pagamento com retencao e um pagamento sem retencao sao o mesmo caso de
  // analise, e o que muda entre eles e o destino do dinheiro.
  const pagamentos = await sql`
    select p.id, p.competence, p.payment_date, p.supplier_cnpj, p.supplier_name,
           p.gross_amount_cents, p.source_document_id, p.source_locator,
           d.original_name as document_name, d.parser_kind,
           coalesce(w.withheld_amount_cents, 0) as withheld_cents,
           coalesce(w.tax_base_cents, 0) as base_retida,
           w.cnr, w.id as withholding_id
    from gov_payments p
    left join gov_withholdings w on w.payment_id = p.id
    left join gov_documents d on d.id = p.source_document_id
    where p.organization_id = ${ctx.organization.id}
      and p.entity_id in (select id from gov_entities where municipality_id = ${mun.id})
    order by p.competence nulls last, p.payment_date nulls last`;

  const sinaisDoMunicipio = await sinaisDeDestino(sql, ctx, mun.id, null);
  const candidatos = [];
  let totalRetido = 0, totalBase = 0, totalPotencial = 0, totalGanhoFuturo = 0;

  for (const r of pagamentos) {
    const retido = Number(r.withheld_cents || 0);
    const base = Number(r.gross_amount_cents || r.base_retida || 0);
    const cnr = r.cnr || null;
    totalRetido += retido;
    totalBase += base;

    const reteve = retido > 0;
    const ehCnr11009 = cnr === '11009';
    // Os sinais de destino sao lidos por competencia: um recolhimento de 2026
    // nao muda o diagnostico de um pagamento de 2024.
    const sinais = await sinaisDeDestino(sql, ctx, mun.id, r.competence);
    // Destino: so ha prova quando o documento traz a evidencia. A apropriacao
    // aparece nos lancamentos contabeis; o repasse a Uniao, nas remessas.
    const apropriadoMunicipio = sinais.lancamentosIrrf > 0 && sinais.apropriadoCents > 0;
    const remetidoUniao = sinais.remessasUniao > 0 || sinais.declaracoesDestino > 0;
    const destinoComprovado = apropriadoMunicipio || remetidoUniao;

    const regra = classificarIrrf({ reteve, destinoComprovado, apropriadoMunicipio, remetidoUniao, cnr, ehCNR11009: ehCnr11009 });

    // Credito retroativo: o que o municipio reteve e passou para a Uniao sem
    // se apropriar (Parecer SEI 480/2025/MF).
    const creditoRetroativo = regra.status === REGRAS_IRRF.RETAINED_REMITTED_UNION ? retido : 0;
    // Ganho futuro: o que o decreto municipal passaria a reter sobre os
    // pagamentos em que nada foi retido.
    const aliquota = r.aliquota || aliquotaDeServico(cnr);
    const ganhoFuturo = (!reteve && base > 0 && aliquota) ? Math.round(base * aliquota) : 0;
    totalPotencial += creditoRetroativo;
    totalGanhoFuturo += ganhoFuturo;

    let statusCandidato;
    if (regra.status === REGRAS_IRRF.RETAINED_AND_RECOGNIZED) statusCandidato = 'REJECTED';
    else if (regra.status === REGRAS_IRRF.NO_WITHHOLDING) statusCandidato = ganhoFuturo > 0 ? 'NEEDS_EVIDENCE' : 'REJECTED';
    else if (regra.status === REGRAS_IRRF.RETAINED_REMITTED_UNION) statusCandidato = 'UNDER_REVIEW';
    else statusCandidato = destinoComprovado ? 'UNDER_REVIEW' : 'NEEDS_EVIDENCE';

    const confianca = destinoComprovado ? 'HIGH' : (r.source_document_id ? 'MEDIUM' : 'LOW');
    const titularidade = (regra.status === REGRAS_IRRF.RETAINED_REMITTED_UNION || ehCnr11009)
      ? 'FEDERAL'
      : (regra.status === REGRAS_IRRF.RETAINED_AND_RECOGNIZED ? 'MUNICIPAL' : 'UNKNOWN');

    let motivo = regra.motivo;
    if (ganhoFuturo > 0) {
      motivo += ` Ganho futuro estimado: R$ ${(ganhoFuturo / 100).toFixed(2)} (${(aliquota * 100).toFixed(2)}% sobre a base) `
        + 'caso o decreto municipal determine a retencao sobre este pagamento.';
    }

    const [candidato] = await sql`
      insert into gov_candidates (
        organization_id, entity_id, period, status,
        gross_candidate_amount_cents, withheld_amount_cents, proven_destination_amount_cents,
        potential_amount_cents, forward_gain_cents, confidence, legal_owner, cnr, rule_id, decision_reason
      )
      values (
        ${ctx.organization.id}, ${entityId}, ${r.competence || null}, ${statusCandidato},
        ${base}, ${retido}, ${destinoComprovado ? retido : 0}, ${creditoRetroativo}, ${ganhoFuturo},
        ${confianca}, ${titularidade}, ${cnr}, ${regra.status}, ${motivo}
      )
      returning id, created_at`;

    if (r.source_document_id) {
      await sql`
        insert into gov_evidence_links (organization_id, candidate_id, document_id, evidence_type, record_locator)
        values (
          ${ctx.organization.id}, ${candidato.id}, ${r.source_document_id},
          ${TIPOS_EVIDENCIA[r.parser_kind] || 'DOCUMENTO'},
          ${r.source_locator || r.document_name || null}
        )`;
    }

    candidatos.push({
      id: candidato.id,
      status: statusCandidato,
      rule: regra.status,
      motivo,
      cnpj: r.supplier_cnpj,
      fornecedor: r.supplier_name,
      competencia: r.competence,
      dataPagamento: r.payment_date,
      baseCents: base,
      retidoCents: retido,
      creditoRetroativoCents: creditoRetroativo,
      ganhoFuturoCents: ganhoFuturo,
      aliquota: aliquota || null,
      confianca,
      titularidade,
      cnr,
      documento: r.document_name || null,
      evidencia: r.source_locator || null,
    });
  }

  return {
    municipalityId: mun.id,
    municipio: mun.name,
    ibgeCode: mun.ibge_code,
    uf: mun.state,
    pagamentos: pagamentos.length,
    retidoTotalCents: totalRetido,
    baseTotalCents: totalBase,
    creditoRecuperavelCents: totalPotencial,
    ganhoFuturoCents: totalGanhoFuturo,
    candidatos,
    sinaisDestino: sinaisDoMunicipio,
    geradoEm: new Date().toISOString(),
  };
}

// Aliquota de referencia para servicos (CNR 06xxx): 1,5%. E uma referencia
// de trabalho — a aliquota vigente deve ser conferida na IN em vigor
// (IN RFB 2.145/2023 e alteracoes) e na lei municipal do ISS.
function aliquotaDeServico(cnr) {
  if (!cnr) return null;
  if (/^06/.test(cnr)) return 0.015;
  return null;
}

async function obterDiagnostico(ctx, municipalityId) {
  const sql = getSql();
  V.uuid(municipalityId);
  const [mun] = await sql`
    select id, name, ibge_code, state from gov_municipalities
    where id = ${municipalityId}::uuid and organization_id = ${ctx.organization.id} limit 1`;
  if (!mun) throw new HttpError(404, 'NOT_FOUND', 'Município não encontrado.');
  return { diagnostico: [await diagnosticoDoMunicipio(sql, ctx, mun)] };
}

module.exports = {
  TIPOS_EVIDENCIA, TIPOS_ENTIDADE,
  listarDocumentos, registrarDocumento, processarDocumento,
  executarDiagnostico, obterDiagnostico,
};
