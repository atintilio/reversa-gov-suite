// Reversa Gov — frontend do módulo IRRF Municipal (isolado, aditivo).
// Chamadas API via RV.api() e estado de tela.
// Nenhuma interação com páginas ou rotas existentes do Reversa.

(function () {
  'use strict';

  async function carregarMunicipios() {
    try {
      const q = document.getElementById('busca-municipio').value.trim();
      const params = q ? `?q=${encodeURIComponent(q)}` : '';
      const dados = await RV.api('GET', `/api/v1/gov/municipios${params}`);
      const tbody = document.getElementById('tbody-municipios');
      tbody.innerHTML = '';

      if (!dados.municipios || dados.municipios.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="gov-empty">Nenhum município encontrado.</td></tr>';
        return;
      }

      tbody.innerHTML = dados.municipios.map((m) => `
        <tr class="click" data-id="${RV.esc(m.id)}">
          <td><strong>${RV.esc(m.name)}</strong></td>
          <td class="num">${RV.esc(m.ibgeCode)}</td>
          <td>${RV.esc(m.state)}</td>
          <td class="num">${RV.esc(m.cnpjRoot || '—')}</td>
          <td><span class="gov-badge ${m.status === 'active' ? 'ok' : 'warn'}">${RV.esc(m.status)}</span></td>
        </tr>
      `).join('');
    } catch (e) {
      const tbody = document.getElementById('tbody-municipios');
      tbody.innerHTML = `<tr><td colspan="5" class="gov-alert bad">${RV.esc(e.message)}</td></tr>`;
    }
  }

  async function carregarCandidatos() {
    try {
      const status = document.getElementById('filtro-status').value;
      const params = status ? `?status=${encodeURIComponent(status)}` : '';
      const dados = await RV.api('GET', `/api/v1/gov/candidatos${params}`);
      const tbody = document.getElementById('tbody-candidatos');
      tbody.innerHTML = '';

      if (!dados.candidatos || dados.candidatos.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="gov-empty">Nenhum candidato encontrado.</td></tr>';
        return;
      }

      tbody.innerHTML = dados.candidatos.map((c) => `
        <tr class="click" data-id="${RV.esc(c.id)}">
          <td><strong>${RV.esc(c.entityName || '—')}</strong><div class="muted mono" style="font-size:12px">${RV.esc(c.entityCnpj || '—')}</div></td>
          <td class="num">${RV.esc(c.period || '—')}</td>
          <td class="num">${RV.reaisCurto(c.withheldAmountCents)}</td>
          <td class="num">${c.potentialAmountCents != null ? RV.reaisCurto(c.potentialAmountCents) : '—'}</td>
          <td><span class="gov-badge ${c.confidence === 'HIGH' ? 'ok' : c.confidence === 'MEDIUM' ? 'warn' : 'info'}">${RV.esc(c.confidence || '—')}</span></td>
          <td><span class="gov-badge info">${RV.esc(c.status)}</span></td>
        </tr>
      `).join('');
    } catch (e) {
      const tbody = document.getElementById('tbody-candidatos');
      tbody.innerHTML = `<tr><td colspan="6" class="gov-alert bad">${RV.esc(e.message)}</td></tr>`;
    }
  }

  async function carregarKPIs() {
    try {
      // Tenta buscar dashboard; se não existir ainda, exibe placeholders
      try {
        const dados = await RV.api('GET', '/api/v1/gov/dashboard');
        document.getElementById('kpi-municipios').textContent = dados.municipios ?? '—';
        document.getElementById('kpi-candidatos').textContent = dados.candidatos ?? '—';
        document.getElementById('kpi-revisao').textContent = dados.emRevisao ?? '—';
        document.getElementById('kpi-validados').textContent = dados.validados ?? '—';
      } catch (e) {
        // Dashboard ainda não implementado no backend; manter placeholders
      }
    } catch (e) {
      // silencioso
    }
  }

  function esc(s) { return RV.esc(s == null ? '' : s); }

  document.getElementById('busca-municipio').addEventListener('input', carregarMunicipios);
  document.getElementById('filtro-status').addEventListener('change', carregarCandidatos);

  // Navegação: clique em linha de município pode abrir detalhe (placeholder)
  document.getElementById('tbody-municipios').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) RV.toast(`Município ${tr.dataset.id} — detalhamento em próxima fase.`);
  });

  document.getElementById('tbody-candidatos').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) RV.toast(`Candidato ${tr.dataset.id} — detalhamento em próxima fase.`);
  });

  // Cadastro de município: o módulo só serve para diagnóstico se o ente
  // público estiver mapeado. O formulário grava via API e recarrega a lista.
  var formMunicipio = document.getElementById('form-municipio');
  var msgMunicipio = document.getElementById('msg-municipio');

  document.getElementById('btn-novo-municipio').addEventListener('click', function () {
    formMunicipio.hidden = !formMunicipio.hidden;
    if (!formMunicipio.hidden) document.getElementById('m-ibge').focus();
  });
  document.getElementById('btn-cancelar-municipio').addEventListener('click', function () {
    formMunicipio.reset();
    formMunicipio.hidden = true;
    msgMunicipio.textContent = '';
  });

  formMunicipio.addEventListener('submit', async function (e) {
    e.preventDefault();
    var botao = document.getElementById('btn-salvar-municipio');
    var cnpjRaiz = document.getElementById('m-cnpj').value.trim();
    botao.disabled = true;
    msgMunicipio.textContent = 'Salvando…';
    try {
      var criado = await RV.api('POST', '/api/v1/gov/municipios', {
        ibgeCode: document.getElementById('m-ibge').value.trim(),
        name: document.getElementById('m-nome').value.trim(),
        state: document.getElementById('m-uf').value,
        cnpjRoot: cnpjRaiz || null,
      });
      formMunicipio.reset();
      formMunicipio.hidden = true;
      msgMunicipio.textContent = '';
      RV.toast(`Município ${criado.name} cadastrado.`);
      await Promise.all([carregarMunicipios(), carregarKPIs()]);
    } catch (erro) {
      msgMunicipio.textContent = erro.message || 'Não foi possível salvar.';
    } finally {
      botao.disabled = false;
    }
  });

  // ------------------------------------------------------------- documentos
  var formDocumento = document.getElementById('form-documento');
  var msgDocumento = document.getElementById('msg-documento');

  function opcoesMunicipios(select, municipioId) {
    var atuais = Array.prototype.slice.call(select.options);
    var municipio = null;
    for (var i = 0; i < dadosMunicipios.length; i++) {
      if (dadosMunicipios[i].id === municipioId) municipio = dadosMunicipios[i];
    }
    atuais.forEach(function (o) { select.removeChild(o); });
    dadosMunicipios.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name + ' (' + m.state + ')';
      select.appendChild(opt);
    });
    if (municipio) select.value = municipio.id;
  }

  var dadosMunicipios = [];

  async function carregarDocumentos() {
    try {
      var dados = await RV.api('GET', '/api/v1/gov/documentos');
      var tbody = document.getElementById('tbody-documentos');
      tbody.innerHTML = '';
      if (!dados.documentos || !dados.documentos.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="gov-empty">Nenhum documento enviado.</td></tr>';
        return;
      }
      tbody.innerHTML = dados.documentos.map(function (d) {
        var resumo = d.summary || {};
        var partes = [];
        if (resumo.retencoes != null) partes.push(resumo.retencoes + ' retenção(ões)');
        if (resumo.pagamentos != null) partes.push(resumo.pagamentos + ' pagamento(s)');
        if (resumo.lancamentos != null) partes.push(resumo.lancamentos + ' lançamento(s)');
        if (resumo.recolhimentos != null) partes.push(resumo.recolhimentos + ' recolhimento(s)');
        var aviso = (resumo.avisos && resumo.avisos.length) ? resumo.avisos[0] : '';
        return '<tr>'
          + '<td><strong>' + esc(d.name) + '</strong><div class="muted mono" style="font-size:12px">' + esc((d.checksum || '').slice(0, 16)) + '</div></td>'
          + '<td>' + esc(d.municipalityName || '—') + '</td>'
          + '<td>' + esc(d.parserKind || '—') + '</td>'
          + '<td><span class="gov-badge ' + (d.status === 'DONE' ? 'ok' : d.status === 'ERROR' ? 'bad' : 'info') + '">' + esc(d.status) + '</span></td>'
          + '<td>' + esc(partes.join(' · ') || aviso || '—') + '</td>'
          + '<td>' + (d.status === 'PENDING' ? '<button type="button" class="gov-btn" data-processar="' + esc(d.id) + '">Ler</button>' : '') + '</td>'
          + '</tr>';
      }).join('');
    } catch (e) {
      document.getElementById('tbody-documentos').innerHTML = '<tr><td colspan="6" class="gov-alert bad">' + esc(e.message) + '</td></tr>';
    }
  }

  document.getElementById('btn-novo-documento').addEventListener('click', function () {
    formDocumento.hidden = !formDocumento.hidden;
    if (!formDocumento.hidden) document.getElementById('d-arquivo').focus();
  });

  formDocumento.addEventListener('submit', async function (e) {
    e.preventDefault();
    var arquivo = document.getElementById('d-arquivo').files[0];
    var msg = document.getElementById('msg-documento');
    if (!arquivo) { msg.textContent = 'Escolha um arquivo.'; return; }
    if (arquivo.size > 4 * 1024 * 1024) { msg.textContent = 'Arquivo acima de 4 MB — envie um período por vez.'; return; }
    var botao = document.getElementById('btn-enviar-documento');
    botao.disabled = true;
    msg.textContent = 'Enviando…';
    try {
      var conteudo = await new Promise(function (resolve, reject) {
        var leitor = new FileReader();
        leitor.onload = function () { resolve(String(leitor.result).split(',')[1] || ''); };
        leitor.onerror = function () { reject(new Error('Falha ao ler o arquivo.')); };
        leitor.readAsDataURL(arquivo);
      });
      var tipo = document.getElementById('d-tipo').value;
      var doc = await RV.api('POST', '/api/v1/gov/documentos', {
        municipalityId: document.getElementById('d-municipio').value,
        name: arquivo.name,
        mimeType: arquivo.type || 'application/octet-stream',
        contentBase64: conteudo,
        parserKind: tipo || null,
      });
      msg.textContent = 'Enviado. Lendo…';
      await RV.api('POST', '/api/v1/gov/documentos/' + doc.id);
      msg.textContent = '';
      formDocumento.reset();
      formDocumento.hidden = true;
      RV.toast('Documento lido.');
      await carregarDocumentos();
    } catch (erro) {
      msg.textContent = erro.message || 'Não foi possível enviar.';
    } finally {
      botao.disabled = false;
    }
  });

  document.getElementById('tbody-documentos').addEventListener('click', async function (e) {
    var botao = e.target.closest('button[data-processar]');
    if (!botao) return;
    botao.disabled = true;
    try {
      await RV.api('POST', '/api/v1/gov/documentos/' + botao.dataset.processar);
      RV.toast('Documento lido.');
      await carregarDocumentos();
    } catch (erro) {
      RV.toast(erro.message || 'Falha ao ler o documento.');
    }
  });

  // ------------------------------------------------------------- cobertura
  async function carregarCobertura() {
    try {
      var sel = document.getElementById('d-municipio-diag');
      var dados = await RV.api('GET', '/api/v1/gov/cobertura' + (sel && sel.value ? '?municipalityId=' + sel.value : ''));
      var tbody = document.getElementById('tbody-cobertura');
      tbody.innerHTML = '';
      if (!dados.cobertura || !dados.cobertura.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="gov-empty">Cadastre um município para ver a cobertura.</td></tr>';
        return;
      }
      var cob = dados.cobertura[0];
      cob.cobertura.forEach(function (l) {
        var badge = l.status === 'completo' ? 'ok' : l.status === 'parcial' ? 'warn' : 'bad';
        tbody.innerHTML += '<tr>'
          + '<td><strong>' + esc(l.ano) + '</strong></td>'
          + '<td><span class="gov-badge ' + badge + '">' + esc(l.status) + '</span></td>'
          + '<td class="num">' + esc(l.pagamentos) + '</td>'
          + '<td class="num">' + RV.reaisCurto(l.retidoCents) + '</td>'
          + '<td>' + esc((l.faltando || []).join(', ') || '—') + '</td>'
          + '</tr>';
      });
    } catch (e) {
      document.getElementById('tbody-cobertura').innerHTML = '<tr><td colspan="5" class="gov-alert bad">' + esc(e.message) + '</td></tr>';
    }
  }

  // ------------------------------------------------------------- Siconfi
  async function carregarTelaPublica() {
    try {
      var sel = document.getElementById('t-municipio');
      var dados = await RV.api('GET', '/api/v1/gov/tela-publica' + (sel && sel.value ? '?municipalityId=' + sel.value : ''));
      var tbody = document.getElementById('tbody-triagem');
      tbody.innerHTML = '';
      if (!dados.tela || !dados.tela.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="gov-empty">Cadastre um município para começar.</td></tr>';
        return;
      }
      var tela = dados.tela[0];
      if (!tela.serie || !tela.serie.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="gov-empty">Nenhuma DCA consultada ainda para este município.</td></tr>';
        return;
      }
      tela.serie.forEach(function (l) {
        var badge = l.sinalLacuna === 'abaixo-da-faixa' ? 'warn' : l.sinalLacuna === 'acima-da-faixa' ? 'info' : 'ok';
        tbody.innerHTML += '<tr>'
          + '<td><strong>' + esc(l.ano) + '</strong></td>'
          + '<td class="num">' + RV.reaisCurto(l.irrfRetidoCents) + '</td>'
          + '<td class="num">' + RV.reaisCurto(l.irrfTotalCents) + '</td>'
          + '<td class="num">' + RV.reaisCurto(l.comprasCents) + '</td>'
          + '<td class="num">' + (l.taxaObservada != null ? (l.taxaObservada * 100).toFixed(2) + '%' : '—') + '</td>'
          + '<td><span class="gov-badge ' + badge + '">' + esc(l.sinalLacuna) + '</span></td>'
          + '</tr>';
      });
    } catch (e) {
      document.getElementById('tbody-triagem').innerHTML = '<tr><td colspan="6" class="gov-alert bad">' + esc(e.message) + '</td></tr>';
    }
  }

  document.getElementById('btn-siconfi').addEventListener('click', async function () {
    var botao = this;
    botao.disabled = true;
    botao.textContent = 'Consultando o Siconfi…';
    try {
      var municipalityId = document.getElementById('t-municipio').value;
      var ano = document.getElementById('t-ano').value;
      var out = await RV.api('POST', '/api/v1/gov/siconfi/buscar', { municipalityId: municipalityId, ano: Number(ano) });
      RV.toast('DCA de ' + out.ano + ' lida: ' + (out.contas || []).length + ' contas.');
      await Promise.all([carregarTelaPublica(), carregarDocumentos()]);
    } catch (erro) {
      RV.toast(erro.message || 'Falha na consulta ao Siconfi.');
    } finally {
      botao.disabled = false;
      botao.textContent = 'Buscar DCA no Siconfi';
    }
  });

  // ------------------------------------------------------------ diagnostico
  document.getElementById('btn-diagnostico').addEventListener('click', async function () {
    var botao = this;
    botao.disabled = true;
    try {
      var municipalityId = document.getElementById('d-municipio-diag').value;
      var dados = await RV.api('POST', '/api/v1/gov/diagnostico', { municipalityId: municipalityId });
      renderDiagnostico(dados.diagnostico[0]);
      await carregarCobertura();
    } catch (erro) {
      RV.toast(erro.message || 'Falha no diagnóstico.');
    } finally {
      botao.disabled = false;
    }
  });

  function renderDiagnostico(diag) {
    if (!diag) return;
    var kpis = [
      ['Retido no período', RV.reaisCurto(diag.retidoTotalCents)],
      ['Crédito recuperável', RV.reaisCurto(diag.creditoRecuperavelCents)],
      ['Ganho futuro (decreto)', RV.reaisCurto(diag.ganhoFuturoCents)],
      ['Pagamentos analisados', String(diag.pagamentos || 0)],
    ];
    document.getElementById('kpis-diagnostico').innerHTML = kpis.map(function (k) {
      return '<div class="gov-kpi"><div class="r">' + esc(k[0]) + '</div><div class="v">' + esc(k[1]) + '</div></div>';
    }).join('');

    var metodo = diag.metodologia || {};
    var bloco = document.getElementById('bloco-metodologia');
    var linhas = Object.keys(metodo).map(function (chave) {
      var rotulo = { retido: 'Retido', creditoRetroativo: 'Crédito recuperável', ganhoFuturo: 'Ganho futuro', aliquota: 'Alíquota', janela: 'Prazo', atualizacao: 'Atualização', validacao: 'Validação', destinoDeclarado: 'Campo destino' }[chave] || chave;
      return '<div><strong>' + esc(rotulo) + ':</strong> ' + esc(metodo[chave]) + '</div>';
    });
    bloco.style.display = linhas.length ? 'block' : 'none';
    document.getElementById('texto-metodologia').innerHTML = linhas.join('');

    var serie = document.getElementById('tbody-serie');
    serie.innerHTML = '';
    (diag.serie || []).forEach(function (a) {
      serie.innerHTML += '<tr>'
        + '<td><strong>' + esc(a.ano) + '</strong></td>'
        + '<td class="num">' + esc(a.pagamentos) + '</td>'
        + '<td class="num">' + RV.reaisCurto(a.baseCents) + '</td>'
        + '<td class="num">' + RV.reaisCurto(a.retidoCents) + '</td>'
        + '<td class="num">' + (a.creditoRetroativoCents ? RV.reaisCurto(a.creditoRetroativoCents) : '—') + '</td>'
        + '<td class="num">' + (a.ganhoFuturoCents ? RV.reaisCurto(a.ganhoFuturoCents) : '—') + '</td>'
        + '</tr>';
    });
    if (!(diag.serie || []).length) serie.innerHTML = '<tr><td colspan="6" class="gov-empty">Sem série no período.</td></tr>';

    var tbody = document.getElementById('tbody-diagnostico');
    tbody.innerHTML = '';
    if (!diag.candidatos || !diag.candidatos.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="gov-empty">Nenhum pagamento analisado. Envie os documentos e execute de novo.</td></tr>';
      return;
    }
    tbody.innerHTML = diag.candidatos.map(function (c) {
      return '<tr>'
        + '<td><strong>' + esc(c.fornecedor || c.cnpj || '—') + '</strong><div class="muted mono" style="font-size:12px">' + esc(c.cnpj || '') + '</div></td>'
        + '<td class="num">' + esc(c.competencia || '—') + '</td>'
        + '<td class="num">' + RV.reaisCurto(c.baseCents) + '</td>'
        + '<td class="num">' + RV.reaisCurto(c.retidoCents) + '</td>'
        + '<td class="num">' + (c.creditoRetroativoCents ? RV.reaisCurto(c.creditoRetroativoCents) : '—') + '</td>'
        + '<td class="num">' + (c.ganhoFuturoCents ? RV.reaisCurto(c.ganhoFuturoCents) : '—') + '</td>'
        + '<td><span class="gov-badge info" title="' + esc(c.motivo) + '">' + esc(c.rule) + '</span></td>'
        + '<td><span class="gov-badge ' + (c.status === 'REJECTED' ? 'bad' : c.status === 'UNDER_REVIEW' ? 'warn' : 'info') + '">' + esc(c.status) + '</span></td>'
        + '</tr>';
    }).join('');
  }

  // Carrega os municípios e popula os seletores.
  async function prepararMunicipios() {
    var dados = await RV.api('GET', '/api/v1/gov/municipios');
    dadosMunicipios = dados.municipios || [];
    opcoesMunicipios(document.getElementById('d-municipio'));
    opcoesMunicipios(document.getElementById('d-municipio-diag'));
    opcoesMunicipios(document.getElementById('t-municipio'));
    var ano = new Date().getFullYear();
    var selAno = document.getElementById('t-ano');
    for (var a = ano - 1; a >= ano - 6; a--) {
      var opt = document.createElement('option');
      opt.value = String(a);
      opt.textContent = String(a);
      selAno.appendChild(opt);
    }
    await Promise.all([carregarCobertura(), carregarTelaPublica()]);
  }

  // Inicialização
  document.getElementById('d-municipio-diag').addEventListener('change', carregarCobertura);
  document.getElementById('t-municipio').addEventListener('change', carregarTelaPublica);
  Promise.all([carregarMunicipios(), carregarCandidatos(), carregarKPIs(), prepararMunicipios(), carregarDocumentos()]);
})();
