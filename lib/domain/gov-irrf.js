// Reversa Gov — motor de classificação de IRRF Municipal (isolado, aditivo).
// Base jurídica (ver lib/gov-normas.js):
//   CF/88 arts. 157, I e 158, I; STF Tema 1.130 (RE 1.293.453/RS);
//   Parecer SEI 5744/2022/ME (PGFN) e Parecer SEI 480/2025/MF;
//   IN RFB 2.145/2023 (arts. 2-A, 3-A, 7-A e 37 §4º); MAFON 2025;
//   MCASP 11a ed. item 3.6.2; EFD-Reinf NT 04/2026 (CNR 11009).
// Não declarar automaticamente que existe crédito.

const REGRAS_IRRF = {
  NO_WITHHOLDING: 'NO_WITHHOLDING',
  RETAINED_AND_RECOGNIZED: 'RETAINED_AND_RECOGNIZED',
  RETAINED_REMITTED_UNION: 'RETAINED_REMITTED_UNION',
  DESTINATION_UNPROVEN: 'DESTINATION_UNPROVEN',
  DECLARATION_MISMATCH: 'DECLARATION_MISMATCH',
  FUTURE_PROCESS_CORRECTION: 'FUTURE_PROCESS_CORRECTION',
};

/**
 * Classifica um evento de IRRF municipal conforme as regras jurídicas.
 *
 * Parâmetros:
 *   reteve (boolean): houve retenção na fonte pelo ente municipal?
 *   destinoComprovado (boolean): destino do valor foi comprovado?
 *   apropriadoMunicipio (boolean): retenção foi apropriada como receita municipal?
 *   remetidoUniao (boolean): valor foi remetido à União?
 *   cnr (string|null): Código Natureza de Rendimento declarado
 *   ehCNR11009 (boolean): é CNR 11009 (IRRF pertencente à União)?
 *
 * Retorna: { status, motivo, creditoAutomatico }
 */
function classificarIrrf({
  reteve = false,
  destinoComprovado = false,
  apropriadoMunicipio = false,
  remetidoUniao = false,
  cnr = null,
  ehCNR11009 = false,
} = {}) {
  // A. Município não reteve → sem crédito automático
  if (!reteve) {
    return {
      status: REGRAS_IRRF.NO_WITHHOLDING,
      motivo:
        'Não houve retenção na fonte. Sem retenção comprovada não há crédito municipal ' +
        'com base no Tema 1.130 (Parecer SEI 480/2025/MF).',
      creditoAutomatico: false,
    };
  }

  // CNR 11009 nunca é default de titularidade municipal
  if (ehCNR11009 || String(cnr ?? '').trim() === '11009') {
    return {
      status: REGRAS_IRRF.DESTINATION_UNPROVEN,
      motivo:
        'CNR 11009 indica IRRF pertencente à União (Nota Técnica 04/2026 da EFD-Reinf). ' +
        'Exigir interpretação contextual e regra jurídica versionada.',
      creditoAutomatico: false,
    };
  }

  // B. Reteve e manteve/apropriou corretamente → não é crédito a recuperar
  if (reteve && apropriadoMunicipio && !remetidoUniao) {
    return {
      status: REGRAS_IRRF.RETAINED_AND_RECOGNIZED,
      motivo:
        'Retenção municipal apropriada como receita própria. Não classificar como crédito a recuperar.',
      creditoAutomatico: false,
    };
  }

  // C. Reteve e repassou à União → investigar, não validar automaticamente
  if (reteve && remetidoUniao) {
    return {
      status: REGRAS_IRRF.RETAINED_REMITTED_UNION,
      motivo:
        'Retenção comprovada e repasse à União. Abrir investigação, não validar crédito automaticamente.',
      creditoAutomatico: false,
    };
  }

  // D. Reteve, destino não demonstrado → bloquear validação
  if (reteve && !destinoComprovado) {
    return {
      status: REGRAS_IRRF.DESTINATION_UNPROVEN,
      motivo: 'Destino do valor não comprovado. Bloquear validação de crédito.',
      creditoAutomatico: false,
    };
  }

  // E. Reteve e destino comprovado → divergência, exigir análise
  if (reteve && destinoComprovado) {
    return {
      status: REGRAS_IRRF.DECLARATION_MISMATCH,
      motivo: 'Divergência entre declaração e contabilidade. Exigir análise.',
      creditoAutomatico: false,
    };
  }

  return {
    status: REGRAS_IRRF.DESTINATION_UNPROVEN,
    motivo: 'Cadeia de evidências incompleta.',
    creditoAutomatico: false,
  };
}

module.exports = { classificarIrrf, REGRAS_IRRF };
