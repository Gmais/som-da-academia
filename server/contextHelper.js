/**
 * Converte 'HH:MM' em minutos desde meia-noite.
 */
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Dado a lista de contextos e um horário (Date), retorna o contexto ativo.
 * Suporta contextos que cruzam a meia-noite (ex: 22:00 -> 02:00).
 * Se nenhum contexto cobrir o horário atual, cai no primeiro contexto cadastrado
 * (evita a tela ficar "sem contexto" em horas mortas).
 */
function getActiveContext(contexts, now = new Date()) {
  const nowMin = now.getHours() * 60 + now.getMinutes();

  for (const ctx of contexts) {
    const start = toMinutes(ctx.hora_inicio);
    const end = toMinutes(ctx.hora_fim);

    if (start === end) continue; // bloco mal configurado, ignora

    const isOvernight = end < start;
    const dentro = isOvernight
      ? nowMin >= start || nowMin < end
      : nowMin >= start && nowMin < end;

    if (dentro) return ctx;
  }

  return contexts[0] || null;
}

module.exports = { getActiveContext, toMinutes };
