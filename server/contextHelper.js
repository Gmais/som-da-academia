// Fuso horário fixo da academia. Como o servidor pode rodar em qualquer lugar
// do mundo quando hospedado no Vercel (geralmente em UTC), não dá pra confiar
// no relógio local do processo — calculamos o horário de Guarapuava explicitamente.
const TIMEZONE = 'America/Sao_Paulo';

/**
 * Retorna os minutos desde meia-noite, no horário de Guarapuava,
 * independente de em qual fuso o processo Node está rodando.
 */
function nowMinutesInGymTimezone(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const hour = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  return hour * 60 + minute;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Dado a lista de contextos e um horário, retorna o contexto ativo.
 * Suporta contextos que cruzam a meia-noite (ex: 22:00 -> 02:00).
 * Se nenhum contexto cobrir o horário atual, cai no primeiro contexto cadastrado.
 */
function getActiveContext(contexts, date = new Date()) {
  const nowMin = nowMinutesInGymTimezone(date);

  for (const ctx of contexts) {
    const start = toMinutes(ctx.hora_inicio);
    const end = toMinutes(ctx.hora_fim);

    if (start === end) continue;

    const isOvernight = end < start;
    const dentro = isOvernight
      ? nowMin >= start || nowMin < end
      : nowMin >= start && nowMin < end;

    if (dentro) return ctx;
  }

  return contexts[0] || null;
}

module.exports = { getActiveContext, toMinutes, nowMinutesInGymTimezone, TIMEZONE };
