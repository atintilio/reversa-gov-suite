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

  // Inicialização
  Promise.all([carregarMunicipios(), carregarCandidatos(), carregarKPIs()]);
})();
