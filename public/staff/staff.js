const strips = document.getElementById('strips');
const activeBanner = document.getElementById('active-context-name');
const clockEl = document.getElementById('clock');
const contextEditor = document.getElementById('context-editor');
const qrImg = document.getElementById('qr-img');

let viewingContextId = null; // null = segue o contexto ativo automaticamente
let lastData = null;

function fmtDuration(ms) {
  if (!ms) return '--:--';
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function fmtClock(date) {
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function levelDots(naFila, max = 5) {
  const on = Math.min(naFila, max);
  return Array.from({ length: max }, (_, i) =>
    `<span class="${i < on ? 'on' : ''}"></span>`
  ).join('');
}

function renderTrackRow(item) {
  const isPlaying = item.status === 'tocando';
  return `
    <div class="track-row" data-status="${item.status}" data-id="${item.id}">
      <img class="track-row__cover" src="${item.capa_url || ''}" alt="" loading="lazy" />
      <div class="track-row__info">
        <div class="track-row__name">${escapeHtml(item.nome)}</div>
        <div class="track-row__artist">${escapeHtml(item.artista)}</div>
      </div>
      <div class="track-row__duration">${fmtDuration(item.duracao_ms)}</div>
      <div class="track-row__actions">
        <a class="btn btn--ghost" href="https://open.spotify.com/search/${encodeURIComponent(item.nome + ' ' + item.artista)}" target="_blank" rel="noopener">Abrir</a>
        ${!isPlaying ? `<button class="btn btn--primary" data-action="tocando" data-id="${item.id}">Tocando</button>` : `<button class="btn btn--primary" data-action="tocada" data-id="${item.id}">Tocada</button>`}
        <button class="btn btn--danger" data-action="removida" data-id="${item.id}">Remover</button>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function render(data) {
  lastData = data;
  activeBanner.textContent = data.activeContext ? data.activeContext.nome : 'nenhum contexto configurado';

  strips.innerHTML = data.contexts
    .map((ctx) => {
      const isViewing = ctx.id === (viewingContextId || data.activeContext?.id);
      const isActiveContext = data.activeContext && ctx.id === data.activeContext.id;
      const items = isViewing ? data.items : [];

      const body = isViewing
        ? `<div class="strip__body" data-body>
             ${items.length ? items.map(renderTrackRow).join('') : '<div class="empty-row">Nenhuma sugestão na fila ainda. Compartilhe o QR code com os alunos.</div>'}
           </div>`
        : `<div class="strip__body" hidden></div>`;

      return `
        <div class="strip ${isActiveContext ? 'strip--active' : ''}" style="--strip-color:${ctx.cor}" data-context-id="${ctx.id}">
          <div class="strip__header" data-toggle="${ctx.id}">
            <span class="strip__name">${escapeHtml(ctx.nome)} ${isActiveContext ? '· ativo agora' : ''}</span>
            <span class="strip__meta">
              <span class="strip__time">${ctx.hora_inicio}–${ctx.hora_fim}</span>
              <span class="level">${levelDots(ctx.naFila)}</span>
              <span class="strip__count">${ctx.naFila} na fila</span>
            </span>
          </div>
          ${body}
        </div>
      `;
    })
    .join('');

  renderContextEditor(data.contexts);
}

function renderContextEditor(contexts) {
  contextEditor.innerHTML = contexts
    .map(
      (ctx) => `
      <div class="ctx-edit-row" data-ctx-id="${ctx.id}">
        <input type="text" value="${escapeHtml(ctx.nome)}" data-field="nome" />
        <input type="time" value="${ctx.hora_inicio}" data-field="hora_inicio" />
        <input type="time" value="${ctx.hora_fim}" data-field="hora_fim" />
      </div>`
    )
    .join('');
}

async function loadQueue() {
  const qs = viewingContextId ? `?contextId=${viewingContextId}` : '';
  const res = await fetch(`/api/queue${qs}`);
  const data = await res.json();
  render(data);
}

strips.addEventListener('click', async (e) => {
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    const id = Number(toggle.dataset.toggle);
    viewingContextId = viewingContextId === id ? null : id;
    loadQueue();
    return;
  }

  const actionBtn = e.target.closest('[data-action]');
  if (actionBtn) {
    const id = actionBtn.dataset.id;
    const status = actionBtn.dataset.action;
    await fetch(`/api/queue/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    loadQueue();
  }
});

contextEditor.addEventListener('change', async (e) => {
  const row = e.target.closest('[data-ctx-id]');
  if (!row) return;
  const id = row.dataset.ctxId;
  const payload = {};
  row.querySelectorAll('[data-field]').forEach((input) => {
    payload[input.dataset.field] = input.value;
  });
  await fetch(`/api/contexts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  loadQueue();
});

function tickClock() {
  clockEl.textContent = fmtClock(new Date());
}

qrImg.src = '/api/qrcode?' + Date.now();

tickClock();
setInterval(tickClock, 1000 * 10);
loadQueue();
setInterval(loadQueue, 1000 * 15);