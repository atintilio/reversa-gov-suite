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
const siconfi = require('../gov-siconfi');
const normas = require('../gov-normas');

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
    else if (doc.parser_kind === 'esocial') lido = parsers.parseEsocial(texto);
    else throw new HttpError(400, 'UNKNOWN_FORMAT', 'Formato não reconhecido. Aceitos: EFD-Reinf, ECD, eventos de folha do eSocial, planilha de retenção ou relatório de pagamentos.');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    await sql`update gov_documents set process_status = 'ERROR', error_message = ${String(error.message || error).slice(0, 400)} where id = ${doc.id}`;
    throw new HttpError(500, 'PARSE_ERROR', 'Não foi possível ler o documento.');
  }

  const resumo = { tipo: lido.tipo, avisos: (lido.avisos || []).slice(0, 20) };
  let pagamentos = 0, retencoes = 0, entidades = 0, lancamentos = 0, remessas = 0;

  if (lido.tipo === 'esocial') {
    // A folha nao vira retencao aqui: o apuracao preprocessarioaria e do
    // Reversa Tax. O Gov registra os eventos e as competencias leidos e
    // deixa o arquivo pronto para ser enviado ao Tax.
    await sql`
      update gov_documents
      set process_status = 'PARSED', parsed_summary = ${JSON.stringify({
        ...resumo,
        eventos: lido.eventos,
        competencias: lido.competencias,
      })}::jsonb, error_message = null
      where id = ${doc.id}`;
    await audit('gov.documento.processado', {
      organizationId: ctx.organization.id, actorUserId: ctx.user.id,
      entityType: 'gov_document', entityId: doc.id,
      metadata: { tipo: 'esocial', eventos: (lido.eventos || []).length, competencias: (lido.competencias || []).length },
    });
    return { id: doc.id, tipo: 'esocial', status: 'PARSED', resumo, eventos: lido.eventos, competencias: lido.competencias };
  }

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
    // A aliquota do documento: a coluna ALIQUOTA quando existe; senao a taxa
    // implicita pelo proprio documento (valor retido / base), que e a pratica
    // do municipio — um dado, nao uma suposicao. Sem nenhuma das duas, a
    // aliquota fica desconhecida e o ganho futuro nao e estimado.
    const registros = lido.registros || [];
    const taxasImplicitas = registros
      .filter((r) => r.withheldCents > 0 && r.baseCents > 0)
      .map((r) => r.withheldCents / r.baseCents);
    const taxaDeclarada = registros.find((r) => r.rate != null);
    const taxaImplicita = taxasImplicitas.length
      ? (() => {
        const ordenadas = [...taxasImplicitas].sort((a, b) => a - b);
        return ordenadas[Math.floor(ordenadas.length / 2)];
      })()
      : null;
    const taxaDoDocumento = taxaDeclarada ? taxaDeclarada.rate : taxaImplicita;
    for (const r of registros) {
      const taxa = r.rate != null ? r.rate : taxaDoDocumento;
      // O destino declarado no documento e a evidencia mais forte que existe:
      // vem da propria linha da retencao, nao de inferencia municipal.
      const titularidade = titularidadeDeclarada(r.destinatario);
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
          ${ctx.organization.id}, ${pagamento.id}, 'IRRF', ${r.baseCents || 0}, ${taxa},
          ${r.withheldCents || 0}, ${r.dataPagamento}, null, ${r.cnr || null},
          ${titularidade}, ${doc.id}
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

// Titularidade declarada no documento ("DESTINATARIO"): MUNICIPIO/UNIAO.
// E o que o proprio documento afirma — nao uma inferencia.
function titularidadeDeclarada(valor) {
  const t = String(valor || '').toUpperCase();
  if (!t) return 'UNKNOWN';
  if (t.indexOf('UNIA') >= 0 || t.indexOf('UNIÃO') >= 0 || t.indexOf('FEDERAL') >= 0) return 'FEDERAL';
  if (t.indexOf('MUNIC') >= 0 || t.indexOf('PREFEIT') >= 0) return 'MUNICIPAL';
  return 'UNKNOWN';
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
      and (e.account_code like '4%' or e.account_code like 'RO%')
      and upper(coalesce(e.account_description, '') || ' ' || coalesce(e.account_code, '')) like '%IRRF%'`;
  const [remet] = await sql`
    select count(*)::int n, coalesce(sum(amount_cents), 0)::bigint total
    from gov_remittances r
    join gov_documents d on d.id = r.source_document_id
    where r.organization_id = ${ctx.organization.id}
      and d.municipality_id = ${municipalityId}
      and (${competencia}::date is null or to_char(r.payment_date, 'YYYY-MM') = left(${competencia}::text, 7))
      and upper(coalesce(r.recipient, '')) like any (array['%UNI%O%','%RECEITA FEDERAL%','%TESOURARIA NACIONAL%'])`;
  // Declaracao do proprio municipio (EFD-Reinf, codigo 6256 no tratamento do
  // MAFON). Prova que a retencao foi declarada — nao que houve repasse a
  // Uniao (isso e o documento de arrecadação com codigo de IRRF).
  const [declarado] = await sql`
    select count(*)::int n
    from gov_declarations c
    join gov_documents d on d.id = c.source_document_id
    where c.organization_id = ${ctx.organization.id}
      and d.municipality_id = ${municipalityId}
      and (${competencia}::date is null or to_char(c.period, 'YYYY-MM') = left(${competencia}::text, 7))
      and c.destination_status = 'SENT_TO_DCTFWEB'`;
  return {
    apropriadoCents: Number(aprop ? aprop.total : 0),
    lancamentosIrrf: aprop ? aprop.n : 0,
    remetidoCents: Number(remet ? remet.total : 0),
    remessasUniao: remet ? remet.n : 0,
    declaracoesEfdReinf: declarado ? declarado.n : 0,
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

// Serie do Siconfi: o que o municipio DECLAROU, ano a ano, na DCA.
// Dado publico do Tesouro — nao depende de documento interno do municipio.
// Mesma premissa dos demais tributos: a janela e a mesma (5 anos).
async function serieSiconfiDoMunicipio(sql, ctx, municipalityId) {
  const docs = await sql`
    select d.original_name, d.parsed_summary
    from gov_documents d
    where d.organization_id = ${ctx.organization.id}
      and d.municipality_id = ${municipalityId}::uuid
      and d.parser_kind = 'siconfi'
    order by d.received_at desc`;
  const porAno = new Map();
  for (const d of docs) {
    const s = d.parsed_summary;
    if (!s || !s.ano) continue;
    const contas = {};
    for (const c of (s.contas || [])) {
      if (c && c.codigo) contas[c.codigo] = { rotulo: c.rotulo || null, valor: Number(c.valor || 0) };
    }
    const ano = Number(s.ano);
    // A consulta vem em received_at DESC: o primeiro registro do ano e o mais
    // recente (o que tem a extracao atual). Nao sobrescrever com o antigo.
    if (porAno.has(ano)) continue;
    porAno.set(ano, {
      ano, fonte: s.fonte || 'Siconfi — DCA', url: s.url || null,
      documento: d.original_name, contas,
    });
  }
  // A janela do modulo: os 5 anos mais recentes com DCA ingerida.
  const todos = [...porAno.values()].sort((a, b) => b.ano - a.ano);
  const serie = todos.slice(0, 5).sort((a, b) => a.ano - b.ano);
  const C = siconfi.CONTAS;
  const val = (a, cod) => (a.contas[cod] ? a.contas[cod].valor : 0);
  // O ISSQN e buscado por ROTULO: o codigo da conta mudou no Treasury ao
  // longo dos exercicios (2021 veio em RO1.1.1.8.02.3.0). Buscar so pelo
  // codigo novo perderia o imposto de 2021 — e "perdido" viraria "zero".
  const valIssqn = (a) => {
    const porRotulo = Object.values(a.contas).find((c) => /ISSQN/i.test(c.rotulo || ''));
    if (porRotulo) return porRotulo.valor;
    return val(a, C.ISSQN);
  };
  for (const a of serie) {
    const irrf = val(a, C.IRRF_TOTAL);
    const irrfServicos = val(a, C.IRRF_OUTROS);
    // A base do IRRF sobre servicos: a soma das despesas com servicos a pessoa
    // juridica (outros servicos, consultoria e TI/comunicacao). A coluna e
    // "Despesas Pagas" — a retencao nasce do pagamento. Ver lib/gov-siconfi.js.
    const baseServicos = val(a, C.DESPESA_SERVICOS_PJ) + val(a, C.DESPESA_CONSULTORIA) + val(a, C.DESPESA_TI);
    a.irrf = { retido: irrf, outros: val(a, C.IRRF_OUTROS), trabalho: val(a, C.IRRF_TRABALHO) };
    a.issqn = { arrecadado: valIssqn(a), receitaDeServicos: val(a, C.RECEITA_SERVICOS) };
    a.despesas = {
      servicosPj: val(a, C.DESPESA_SERVICOS_PJ),
      consultoria: val(a, C.DESPESA_CONSULTORIA),
      ti: val(a, C.DESPESA_TI),
      baseServicosIrrf: baseServicos,
      total: val(a, C.DESPESA_TOTAL),
      coluna: 'Despesas Pagas',
    };
    // Taxa observada do IRRF: o IRRF retido SOBRE SERVICOS (natureza "outros")
    // divided pela compra de servicos de terceiros. E PISO: nem toda compra de
    // servico gera IRRF (ha aliqquotas diferentes por item e isencoes) e a
    // base nao separa os itens por aliquota. Sinal de triagem, nunca conclusao.
    // O IRRF TOTAL nao entra: ele inclui o IRRF da folha de pagamento, que nao
    // tem relacao com a compra de servicos — a soma daria uma taxa sem
    // significado (a folha de Tupaciguara sozinha e R$ 4,9 mi contra R$ 31 mi
    // de compras).
    a.taxaObservadaIrrf = baseServicos > 0 ? irrfServicos / baseServicos : null;
    a.taxaObservadaIrrfTotal = baseServicos > 0 ? irrf / baseServicos : null;
    // ISSQN: a DCA traz o imposto arrecadado, nao a base de calculo. Sem base
    // nao ha taxa — a aliquota do ISSQN vem do decreto municipal (LC 116/2003).
    a.taxaObservadaIssqn = null;
  }
  return {
    anos: serie.length,
    serie,
    anosDisponiveis: todos.map((a) => a.ano),
    ressalvas: [
      'A DCA e anual: a serie do Siconfi tem 1 ponto por ano de exercicio, nao 12 competencias por ano.',
      'A taxa observada do IRRF usa o IRRF retido SOBRE SERVICOS (natureza "outros") sobre a compra de servicos de terceiros. E um PISO: a base de compras inclui bens, que nao geram IRRF.',
      'O IRRF total (que inclui o da folha de pagamento) nao entra na taxa: a folha nao e compra de servico.',
      'O ISSQN entra pelo valor arrecadado; a base de calculo nao consta da DCA, portanto nao ha taxa observada de ISSQN. A aliquota vem do decreto municipal (LC 116/2003).',
      'Valor declarado no Siconfi nao e valor reconhecido: a conferencia e com o contador.',
    ],
  };
}

// ------------------------------------------------------------ recuperavel preliminar
// Calcula, a partir da serie do Siconfi, o TETO do que a defasagem de retencao
// permitiria recuperar. "Teto" porque a base de compras de servicos inclui
// itens com aliquota maior e isencoes: o valor real e igual ou menor.
//
// O que nao tem base no dado publico nao vira zero: vira "a dimensionar",
// com a evidencia exata que falta.
const ALIQUOTA_IRRF_SERVICOS = 0.015; // Lei 9.249/1995 art. 30, II, "a"; IN RFB 1.234/2012 art. 30, I

function recuperavelPreliminar(serieSiconfi) {
  const serie = (serieSiconfi && serieSiconfi.serie) || [];
  const soma = (f) => serie.reduce((s, l) => s + (f(l) || 0), 0);
  const base = soma((l) => (l.despesas && l.despesas.baseServicosIrrf) || 0);
  const observado = soma((l) => (l.irrf && l.irrf.outros) || 0);
  const esperado = base * ALIQUOTA_IRRF_SERVICOS;
  const issqn = soma((l) => (l.issqn && l.issqn.arrecadado) || 0);
  return {
    total: Math.max(0, esperado - observado),
    itens: [
      {
        item: 'IRRF retido em excesso sobre servicos de terceiros',
        baseCents: Math.round(base * 100),
        fator: '1,5%',
        fatorLegal: 'Lei 9.249/1995 art. 30, II, "a"; IN RFB 1.234/2012 art. 30, I',
        observadoCents: Math.round(observado * 100),
        esperadoCents: Math.round(esperado * 100),
        valorCents: Math.round(Math.max(0, esperado - observado) * 100),
        fonte: 'Siconfi DCA: Anexo I-D, coluna "Despesas Pagas" (servicos a PJ) x Anexo I-C, coluna "Receitas Brutas Realizadas" (IRRF retido - outros)',
        grau: 'teto',
        nota: 'A base inclui servicos com aliquota superior a 1,5% e itens isentos: o valor real e igual ou menor que este teto. Nao e credito reconhecido.',
      },
      {
        item: 'ISSQN — defasagem de base de calculo',
        baseCents: null,
        fator: '2% a 5% (CTM do municipio, Tabela I)',
        fatorLegal: 'CTM de Tupaciguara art. 77 (base = preco do servico) e art. 266 (aliquota minima 2%, maxima 5%)',
        observadoCents: Math.round(issqn * 100),
        esperadoCents: null,
        valorCents: null,
        fonte: 'Siconfi DCA: Anexo I-C, linha do ISSQN (arrecadado). A BASE DE CALCULO NAO CONSTA DA DCA',
        grau: 'a dimensionar',
        nota: 'Sem a base de calculo nao ha como calcular a defasagem. A evidencia que falta e a NFS-e emitida no municipio (valor dos servicos) e o decreto vigente.',
      },
    ],
  };
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
           w.rate, w.legal_owner as titularidade_declarada,
           w.cnr, w.id as withholding_id
    from gov_payments p
    left join gov_withholdings w on w.payment_id = p.id
    left join gov_documents d on d.id = p.source_document_id
    where p.organization_id = ${ctx.organization.id}
      and p.entity_id in (select id from gov_entities where municipality_id = ${mun.id})
    order by p.competence nulls last, p.payment_date nulls last`;

  const sinaisDoMunicipio = await sinaisDeDestino(sql, ctx, mun.id, null);
  const serieSiconfi = await serieSiconfiDoMunicipio(sql, ctx, mun.id);
  const janela12Meses = { de: dataMenos(12), ate: dataMais(1) };
  const candidatos = [];
  let totalRetido = 0, totalBase = 0, totalPotencial = 0, totalGanhoFuturo = 0;

  for (const r of pagamentos) {
    const retido = Number(r.withheld_cents || 0);
    // A base e a base declarada no documento (base de calculo do imposto).
    // Sem ela, usa-se o valor bruto do pagamento — que e a base de calculo
    // Padrao do IRRF (Manual Tecnico do IRRF).
    const base = Number(r.base_retida || r.gross_amount_cents || 0);
    const baseDeclarada = Number(r.base_retida || 0) > 0;
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
    // O destino tem tres niveis de evidencia. O mais forte e o proprio
    // documento da retencao (campo DESTINATARIO); o seguinte e o conjunto do
    // periodo (ECD, DARF); o mais fraco e a inferencia.
    const declarado = r.titularidade_declarada || 'UNKNOWN';
    const provaNoDocumento = declarado !== 'UNKNOWN';
    const apropriadoMunicipio = provaNoDocumento
      ? declarado === 'MUNICIPAL'
      : (sinais.lancamentosIrrf > 0 && sinais.apropriadoCents > 0);
    const remetidoUniao = provaNoDocumento
      ? declarado === 'FEDERAL'
      : (sinais.remessasUniao > 0 || sinais.declaracoesDestino > 0);
    const destinoComprovado = apropriadoMunicipio || remetidoUniao;
    const nivelEvidencia = provaNoDocumento ? 'documento' : (destinoComprovado ? 'periodo' : 'nenhuma');

    const regra = classificarIrrf({ reteve, destinoComprovado, apropriadoMunicipio, remetidoUniao, cnr, ehCNR11009: ehCnr11009 });

    // Credito retroativo: o que o municipio reteve e passou para a Uniao sem
    // se apropriar (Parecer SEI 480/2025/MF).
    const creditoRetroativo = regra.status === REGRAS_IRRF.RETAINED_REMITTED_UNION ? retido : 0;
    // Ganho futuro: o que o decreto municipal passaria a reter sobre os
    // pagamentos em que nada foi retido. Conta so a janela de 12 meses
    // (run-rate anual) — somar cinco anos de histórico inflaria o número.
    // A aliquota vem do documento (coluna ALIQUOTA ou taxa implicita). Nao
    // existe aliquota fixa no modulo: a IN 2.145/2023 varia de 1,2% a 4,8%
    // conforme a natureza do servico, e o contrato e a lei municipal que
    // definem a aplicacao no caso concreto.
    const aliquota = r.rate != null ? Number(r.rate) : null;
    const naJanela = dentroDaJanela(r.competence, janela12Meses);
    const ganhoFuturo = (!reteve && base > 0 && aliquota && naJanela) ? Math.round(base * aliquota) : 0;
    totalPotencial += creditoRetroativo;
    totalGanhoFuturo += ganhoFuturo;

    let statusCandidato;
    if (regra.status === REGRAS_IRRF.RETAINED_AND_RECOGNIZED) statusCandidato = 'REJECTED';
    else if (regra.status === REGRAS_IRRF.NO_WITHHOLDING) {
      // Havia pagamento com base e nada foi retido: ha potencial, mas a
      // estimativa depende da aliquota (o proprio documento ou a lei). Sem
      // base nao ha o que analisar.
      statusCandidato = base > 0 ? 'NEEDS_EVIDENCE' : 'REJECTED';
    }
    else if (regra.status === REGRAS_IRRF.RETAINED_REMITTED_UNION) statusCandidato = 'UNDER_REVIEW';
    else statusCandidato = destinoComprovado ? 'UNDER_REVIEW' : 'NEEDS_EVIDENCE';

    // A confianca reflecte a(forca da evidencia, nao a existencia dela.
    const confianca = nivelEvidencia === 'documento' ? 'HIGH'
      : (nivelEvidencia === 'periodo' ? 'MEDIUM' : (r.source_document_id ? 'LOW' : 'LOW'));
    const titularidade = (regra.status === REGRAS_IRRF.RETAINED_REMITTED_UNION || ehCnr11009)
      ? 'FEDERAL'
      : (regra.status === REGRAS_IRRF.RETAINED_AND_RECOGNIZED ? 'MUNICIPAL' : 'UNKNOWN');

    let motivo = regra.motivo;
    if (!reteve && base > 0 && !aliquota) {
      motivo += ' Sem aliquota no documento: o ganho futuro nao foi estimado. A aliquota aplicavel '
        + 'precisa vir do documento (coluna ALIQUOTA ou taxa implicita) ou do decreto municipal.';
    }
    if (ganhoFuturo > 0) {
      motivo += ` Ganho futuro estimado: R$ ${(ganhoFuturo / 100).toFixed(2)} (${(aliquota * 100).toFixed(2)}% sobre a base) `
        + 'caso o decreto municipal determine a retencao sobre este pagamento.';
    }

    // Idempotencia: o candidato e do pagamento. Rodar o diagnostico de novo
    // atualiza o mesmo candidato (e preserva a revisao humana), em vez de
    // duplicar a lista.
    const [existente] = await sql`
      select id from gov_candidates
      where organization_id = ${ctx.organization.id} and payment_id = ${r.id} limit 1`;
    let candidato;
    if (existente) {
      [candidato] = await sql`
        update gov_candidates set
          status = ${statusCandidato},
          gross_candidate_amount_cents = ${base},
          withheld_amount_cents = ${retido},
          proven_destination_amount_cents = ${destinoComprovado ? retido : 0},
          potential_amount_cents = ${creditoRetroativo},
          forward_gain_cents = ${ganhoFuturo},
          confidence = ${confianca},
          legal_owner = ${titularidade},
          cnr = ${cnr},
          rule_id = ${regra.status},
          decision_reason = ${motivo},
          updated_at = now()
        where id = ${existente.id}
        returning id, created_at`;
    } else {
      [candidato] = await sql`
        insert into gov_candidates (
          organization_id, entity_id, payment_id, period, status,
          gross_candidate_amount_cents, withheld_amount_cents, proven_destination_amount_cents,
          potential_amount_cents, forward_gain_cents, confidence, legal_owner, cnr, rule_id, decision_reason
        )
        values (
          ${ctx.organization.id}, ${entityId}, ${r.id}, ${r.competence || null}, ${statusCandidato},
          ${base}, ${retido}, ${destinoComprovado ? retido : 0}, ${creditoRetroativo}, ${ganhoFuturo},
          ${confianca}, ${titularidade}, ${cnr}, ${regra.status}, ${motivo}
        )
        returning id, created_at`;
    }

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
      competencia: competenciaTexto(r.competence),
      dataPagamento: r.payment_date,
      baseCents: base,
      retidoCents: retido,
      creditoRetroativoCents: creditoRetroativo,
      ganhoFuturoCents: ganhoFuturo,
      aliquota: aliquota || null,
      confianca,
      nivelEvidencia,
      titularidade,
      cnr,
      aliquota,
      baseDoCalculo: baseDeclarada ? 'base declarada no documento' : 'valor bruto do pagamento',
      documento: r.document_name || null,
      evidencia: r.source_locator || null,
    });
  }

  // Visao por ano: o relatorio de impacto que o municipio leva para a
  // administracao mostra a serie dos 5 anos, nao so o total.
  const porAno = {};
  for (const c of candidatos) {
    const ano = (c.competencia || '').slice(0, 4) || 'sem-periodo';
    if (!porAno[ano]) porAno[ano] = { ano, pagamentos: 0, retidoCents: 0, creditoRetroativoCents: 0, ganhoFuturoCents: 0, baseCents: 0 };
    porAno[ano].pagamentos++;
    porAno[ano].retidoCents += c.retidoCents;
    porAno[ano].baseCents += c.baseCents;
    porAno[ano].creditoRetroativoCents += c.creditoRetroativoCents;
    porAno[ano].ganhoFuturoCents += c.ganhoFuturoCents;
  }
  const serie = Object.values(porAno).sort((a, b) => a.ano.localeCompare(b.ano));

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
    serie,
    serieSiconfi,
    // Calculo preliminar do total recuperavel a partir do dado publico.
    // Nao e credito reconhecido: e o teto do que a defasagem de retencao
    // permitiria, calculado sobre a base real e o fator legal. Cada item
    // declara o grau de certeza — quem nao tem base no dado publico fica
    // "a dimensionar", nunca zero.
    recuperavelPreliminar: recuperavelPreliminar(serieSiconfi),
    candidatos,
    sinaisDestino: sinaisDoMunicipio,
    metodologia: {
      retido: 'Valor exato declarado no documento (EFD-Reinf, planilha ou relatorio de pagamentos).',
      creditoRetroativo: 'Hipotese: valor retido pelo municipio cujo destino foi demonstrado como sendo a Uniao, sem apropriacao pelo municipio (Parecer SEI 480/2025/MF). Depende de prova documental.',
      ganhoFuturo: 'Estimativa: base de calculo x aliquota que o proprio documento revela, aplicada a uma janela de 12 meses. Nao e valor reconhecido.',
      aliquota: `Nao ha aliquota fixa no modulo: a faixa da IN RFB 2.145/2023 para servico e ${normas.ALIQUOTAS.FAIXA_TEXTO}. O que vale no caso concreto e o declarado no documento e o que o decreto municipal definir. ${normas.ALIQUOTAS.OBS}`,
      fundamento: normas.FUNDAMENTO,
      fontes: Object.values(normas.NORMAS),
      janela: normas.PRAZO.TEXTO,
      serieSiconfi: 'Serie do Siconfi (Tesouro): o que o municipio Declarou por ano (IRRF retido, ISSQN arrecadado e despesas com servicos). A taxa observada do IRRF e piso de triagem; o ISSQN aparece sem taxa, porque a base de calculo nao consta da DCA e a aliquota vem do decreto municipal.',
      destinoDeclarado: 'O campo DESTINATARIO da planilha e lido como o destino do imposto retido. O significado da coluna precisa ser conferido com o contador antes de usar o resultado em uma acao.',
      atualizacao: `Valores nao monetariamente atualizados: ${normas.ATUALIZACAO.TEXTO}`,
      validacao: 'Nenhum valor e reconhecido sem revisao humana. O status do candidato mostra o estagio da prova.',
    },
    geradoEm: new Date().toISOString(),
  };
}

// O driver devolve date como Date ou como texto, conforme o caminho. A
// normalizacao evita que a comparacao de janela quebre silenciosamente.
function dataIso(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  const m = String(valor).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// A competencia no banco e date; na tela vale o mes.
function competenciaTexto(valor) {
  const iso = dataIso(valor);
  return iso ? iso.slice(0, 7) : null;
}

function dataMeses(n) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
function dataMenos(n) { return dataMeses(-n); }
function dataMais(n) { return dataMeses(n); }
function dentroDaJanela(competencia, janela) {
  const c = dataIso(competencia);
  if (!c) return false;
  return c >= janela.de && c < janela.ate;
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

// -------------------------------------------------------------- Siconfi
// Consulta publica ao Tesouro Nacional: a DCA do municipio diz o que ele
// DECLAROU ter arrecadado de IRRF e quanto gastou com servicos de terceiros
// pessoa juridica. E triagem — nao prova. Serve para apontar onde o dinheiro
// pode estar e para dimensionar o caso antes de pedir documento interno.
async function buscarSiconfi(ctx, body = {}) {
  const sql = getSql();
  const municipalityId = V.text(body.municipalityId, 'Município');
  const ano = Number(body.ano) || (new Date().getUTCFullYear() - 1);
  const [mun] = await sql`
    select id, name, ibge_code, state from gov_municipalities
    where id = ${municipalityId}::uuid and organization_id = ${ctx.organization.id} limit 1`;
  if (!mun) throw new HttpError(404, 'NOT_FOUND', 'Município não encontrado.');
  if (!mun.ibge_code) throw new HttpError(400, 'MISSING_IBGE', 'O município precisa do código IBGE para consultar o Siconfi.');

  const [fonte] = await sql`
    insert into gov_sources (organization_id, name, source_type, base_url)
    values (${ctx.organization.id}, 'Siconfi — Tesouro Nacional (DCA)', 'siconfi', ${siconfi.BASE})
    returning id`;

  let itens;
  try {
    itens = await siconfi.buscarDca(mun.ibge_code, ano);
  } catch (error) {
    throw new HttpError(502, 'SICONFI_UNAVAILABLE', `O Siconfi não respondeu: ${(error.message || '').slice(0, 120)}`);
  }
  const contas = siconfi.extrairContas(itens);
  if (!contas.length) {
    throw new HttpError(404, 'NO_DATA', `O Siconfi não tem DCA de ${ano} para ${mun.name} (código IBGE ${mun.ibge_code}).`);
  }

  const resumo = {
    tipo: 'siconfi',
    ano,
    fonte: 'Siconfi — DCA',
    url: `${siconfi.BASE}/dca?id_ente=${mun.ibge_code}&an_exercicio=${ano}`,
    contas: contas.map((c) => ({ codigo: c.codigo, rotulo: c.rotulo, valor: c.valor })),
  };

  const conteudo = Buffer.from(JSON.stringify(resumo), 'utf8');
  // Reingerir o mesmo ano nao pode duplicar fato. Antes de entrar, sai tudo
  // o que veio da MESMA fonte (Siconfi) para o MESMO ano: lancamentos,
  // declaracoes e o documento anterior. Sem isso, consultar o mesmo ano duas
  // vezes dobrava a base do diagnostico — e o numero do relatorio deixaria
  // de bater com a DCA.
  await sql`
    delete from gov_accounting_entries
    where organization_id = ${ctx.organization.id}
      and source_document_id in (
        select id from gov_documents
        where organization_id = ${ctx.organization.id}
          and parser_kind = 'siconfi'
          and original_name = ${`Siconfi-DCA-${mun.ibge_code}-${ano}`}
      )`;
  await sql`
    delete from gov_declarations
    where organization_id = ${ctx.organization.id}
      and system_name = 'Siconfi DCA'
      and period = ${`${ano}-12-31`}`;
  await sql`
    delete from gov_documents
    where organization_id = ${ctx.organization.id}
      and parser_kind = 'siconfi'
      and original_name = ${`Siconfi-DCA-${mun.ibge_code}-${ano}`}`;

  const [doc] = await sql`
    insert into gov_documents (
      organization_id, municipality_id, original_name, mime_type, size_bytes,
      checksum_sha256, classification, content, content_text, parser_kind,
      process_status, parsed_summary, period_label, uploaded_by
    )
    values (
      ${ctx.organization.id}, ${mun.id}, ${`Siconfi-DCA-${mun.ibge_code}-${ano}`}, 'application/json', ${conteudo.length},
      ${parsers.sha256(conteudo)}, 'public', ${conteudo}, ${conteudo.toString('utf8')}, 'siconfi',
      'DONE', ${JSON.stringify(resumo)}::jsonb, ${`${ano}-12-31`}, ${ctx.user.id}
    )
    returning id`;

  const entityId = await entidadeDoMunicipio(sql, ctx, mun);
  for (const c of contas) {
    // Receita entra como credito; despesa, como debito.
    const ehReceita = c.codigo.startsWith('RO');
    await sql`
      insert into gov_accounting_entries (
        organization_id, entity_id, account_code, account_description, competence,
        debit_cents, credit_cents, journal_reference, source_document_id
      )
      values (
        ${ctx.organization.id}, ${entityId}, ${c.codigo}, ${c.rotulo}, ${`${ano}-12-31`},
        ${ehReceita ? 0 : Math.round(c.valor * 100)}, ${ehReceita ? Math.round(c.valor * 100) : 0},
        ${`DCA ${ano}`}, ${doc.id}
      )`;
  }

  // O IRRF declarado pelo municipio e uma declaracao dele proprio. O destino
  // e SENT_TO_DCTFWEB: conforme o MAFON, a retencao dos entes subnacionais
  // e declarada na EFD-Reinf com o codigo 6256 (tratamento diferenciado) —
  // o municipio nao repassa a Uniao, e o valor e seu (Tema 1.130).
  const irrf = contas.find((c) => c.codigo === siconfi.CONTAS.IRRF_OUTROS);
  const irrfTotal = contas.find((c) => c.codigo === siconfi.CONTAS.IRRF_TOTAL);
  if (irrf) {
    await sql`
      insert into gov_declarations (
        organization_id, entity_id, period, system_name, event_type, receipt_id,
        cnr, declared_amount_cents, destination_status, source_document_id
      )
      values (
        ${ctx.organization.id}, ${entityId}, ${`${ano}-12-31`}, 'Siconfi DCA', 'IRRF_DECLARADO', null,
        null, ${Math.round(irrf.valor * 100)}, 'SENT_TO_DCTFWEB', ${doc.id}
      )`;
  }

  await audit('gov.siconfi.consultado', {
    organizationId: ctx.organization.id, actorUserId: ctx.user.id,
    entityType: 'gov_municipality', entityId: mun.id,
    metadata: { ano, contas: contas.length, irrfRetido: irrf ? irrf.valor : null, irrfTotal: irrfTotal ? irrfTotal.valor : null },
  });

  return {
    ok: true,
    ano,
    municipio: mun.name,
    documentoId: doc.id,
    fonteId: fonte.id,
    contas: resumo.contas,
    irrfRetidoOutrosCents: irrf ? Math.round(irrf.valor * 100) : null,
    irrfTotalCents: irrfTotal ? Math.round(irrfTotal.valor * 100) : null,
  };
}

// Triagem publica: por ano, o IRRF declarado x as compras de servicos a PJ,
// e a taxa de retencao observada (a razao entre os dois).
async function telaPublica(ctx, query = {}) {
  const sql = getSql();
  const municipalityId = query.municipalityId ? V.text(query.municipalityId, 'Município') : null;
  const municipios = await sql`
    select id, name, ibge_code, state from gov_municipalities
    where organization_id = ${ctx.organization.id}
      and (${municipalityId}::uuid is null or id = ${municipalityId}::uuid)
    order by name`;
  if (!municipios.length) throw new HttpError(404, 'NOT_FOUND', 'Nenhum município cadastrado.');

  const resultado = [];
  for (const mun of municipios) {
    const entradas = await sql`
      select e.account_code, e.account_description, e.credit_cents, e.debit_cents,
             extract(year from e.competence)::int ano, d.original_name as documento
      from gov_accounting_entries e
      join gov_documents d on d.id = e.source_document_id
      where e.organization_id = ${ctx.organization.id}
        and d.municipality_id = ${mun.id}
        and d.parser_kind = 'siconfi'
      order by ano`;
    const porAno = {};
    for (const e of entradas) {
      const ano = Number(e.ano);
      if (!porAno[ano]) porAno[ano] = { ano, irrfRetidoCents: 0, irrfTotalCents: 0, comprasCents: 0, documento: e.documento };
      const v = Math.max(Number(e.credit_cents || 0), Number(e.debit_cents || 0));
      if (e.account_code === siconfi.CONTAS.IRRF_OUTROS) porAno[ano].irrfRetidoCents = v;
      if (e.account_code === siconfi.CONTAS.IRRF_TOTAL) porAno[ano].irrfTotalCents = v;
      if (e.account_code === siconfi.CONTAS.DESPESA_SERVICOS_PJ) porAno[ano].comprasCents = v;
    }
    const serie = Object.values(porAno).sort((a, b) => a.ano - b.ano).map((a) => {
      // Taxa observada: o IRRF declarado sobre as compras de servicos a PJ.
      const taxaObservada = a.comprasCents > 0 ? a.irrfRetidoCents / a.comprasCents : null;
      return {
        ...a,
        taxaObservada,
        // A faixa da IN RFB 2.145/2023 para servico e de 1,2% a 4,8%. Uma
        // taxa observada abaixo da faixa e um SINAL de lacuna — nao uma
        // conclusao, porque a base de comparacao inclui bens, que nao
        // geram IRRF.
        sinalLacuna: taxaObservada != null && taxaObservada < normas.ALIQUOTAS.SERVICO_MIN
          ? 'abaixo-da-faixa'
          : (taxaObservada != null && taxaObservada > normas.ALIQUOTAS.SERVICO_MAX ? 'acima-da-faixa' : 'na-faixa'),
        faixaReferencia: normas.ALIQUOTAS.FAIXA_TEXTO,
      };
    });
    resultado.push({
      municipalityId: mun.id,
      municipio: mun.name,
      uf: mun.state,
      ibgeCode: mun.ibge_code,
      serie,
      observacao: 'Triagem publica (DCA do Siconfi). O IRRF vem da natureza 1.1.1.3.03.4.0 (Anexo I-C) e as compras da despesa com servicos de PJ (Anexo I-D). Duas ressalvas: a natureza outros pode reunir retencoes que nao sao apenas sobre prestadores, e a base de compras inclui bens, que nao geram IRRF. Por isso a taxa observada e um SINAL de triagem, nunca uma conclusao.',
    });
  }
  return { tela: resultado };
}

// ---------------------------------------------------------------- cobertura
// A janela util do IRRF e de 5 anos (decadencia do art. 173 do CTN). O
// painel mostra, ano a ano, se o municipio ja entregou os tres documentos que
// odiagnostico exige — e o que ainda falta collectar.
// Janela util: 5 anos para constituir o credito (decadencia, art. 173 do
// CTN) + 5 anos para cobrar (prescricao, art. 174) = 10 anos. Passou disso,
// o direito se extingue — nao ha proposta que salve.
const ANOS_JANELA = 10;

async function cobertura(ctx, query = {}) {
  const sql = getSql();
  const municipalityId = query.municipalityId ? V.text(query.municipalityId, 'Município') : null;
  const municipios = await sql`
    select id, name, ibge_code, state from gov_municipalities
    where organization_id = ${ctx.organization.id}
      and (${municipalityId}::uuid is null or id = ${municipalityId}::uuid)
    order by name`;
  if (!municipios.length) throw new HttpError(404, 'NOT_FOUND', 'Nenhum município cadastrado.');

  const anoAtual = new Date().getUTCFullYear();
  const anos = [];
  for (let i = ANOS_JANELA; i >= 0; i--) anos.push(anoAtual - i);

  const resultado = [];
  for (const mun of municipios) {
    const pagamentos = await sql`
      select extract(year from competence)::int ano, count(*)::int n,
             sum(gross_amount_cents)::bigint base, sum(coalesce(w.withheld_amount_cents,0))::bigint retido
      from gov_payments p
      left join gov_withholdings w on w.payment_id = p.id
      where p.organization_id = ${ctx.organization.id}
        and p.entity_id in (select id from gov_entities where municipality_id = ${mun.id})
      group by 1`;
    const lancamentos = await sql`
      select extract(year from competence)::int ano, count(*)::int n
      from gov_accounting_entries e
      join gov_documents d on d.id = e.source_document_id
      where e.organization_id = ${ctx.organization.id} and d.municipality_id = ${mun.id}
      group by 1`;
    const remessas = await sql`
      select extract(year from r.payment_date)::int ano, count(*)::int n, sum(r.amount_cents)::bigint total
      from gov_remittances r
      join gov_documents d on d.id = r.source_document_id
      where r.organization_id = ${ctx.organization.id} and d.municipality_id = ${mun.id}
      group by 1`;
    const docs = await sql`
      select d.id, d.original_name, d.parser_kind, d.process_status, d.created_at
      from gov_documents d
      where d.organization_id = ${ctx.organization.id} and d.municipality_id = ${mun.id}
      order by d.created_at desc`;

    const porAno = (lista, ano) => (lista.find((x) => Number(x.ano) === ano) || { n: 0 });
    const linhas = anos.map((ano) => {
      const pag = porAno(pagamentos, ano);
      const lan = porAno(lancamentos, ano);
      const rem = porAno(remessas, ano);
      const peca = [];
      if (Number(pag.n) > 0) peca.push('retencoes');
      if (Number(lan.n) > 0) peca.push('destino-contabil');
      if (Number(rem.n) > 0) peca.push('repasse-uniao');
      const faltando = [];
      if (Number(pag.n) === 0) faltando.push('EFD-Reinf ou planilha de retencoes');
      if (Number(lan.n) === 0) faltando.push('ECD');
      if (Number(rem.n) === 0) faltando.push('relatorio de pagamentos ou DARF');
      return {
        ano,
        status: peca.length === 3 ? 'completo' : (peca.length ? 'parcial' : 'vazio'),
        peca,
        faltando,
        pagamentos: Number(pag.n || 0),
        retidoCents: Number(pag.retido || 0),
        baseCents: Number(pag.base || 0),
        lancamentos: Number(lan.n || 0),
        remessas: Number(rem.n || 0),
        repasseCents: Number(rem.total || 0),
      };
    });

    const anosComDado = linhas.filter((l) => l.status !== 'vazio').length;
    resultado.push({
      municipalityId: mun.id,
      municipio: mun.name,
      uf: mun.state,
      ibgeCode: mun.ibge_code,
      janelaAnos: anos.length,
      anosComDado,
      anosFaltantes: anos.length - anosComDado,
      cobertura: linhas,
      documentos: docs.map((d) => ({ id: d.id, name: d.original_name, tipo: d.parser_kind, status: d.process_status })),
      completo: linhas.every((l) => l.status === 'completo'),
    });
  }
  return { cobertura: resultado };
}

module.exports = {
  TIPOS_EVIDENCIA, TIPOS_ENTIDADE, ANOS_JANELA,
  listarDocumentos, registrarDocumento, processarDocumento,
  executarDiagnostico, obterDiagnostico, cobertura,
  buscarSiconfi, telaPublica,
};
