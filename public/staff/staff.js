const strips = document.getElementById('strips');
const activeBanner = document.getElementById('active-context-name');
const clockEl = document.getElementById('clock');
const contextEditor = document.getElementById('context-editor');
const qrImg = document.getElementById('qr-img');
const addContextSelect = document.getElementById('add-context-select');
const addSearchInput = document.getElementById('add-search-input');
const addResultsEl = document.getElementById('add-results');

let knownContexts = [];
let addDebounceTimer = null;
let addLastQuery = '';

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
  renderAddContextSelect(data.contexts, data.activeContext);
}

function renderAddContextSelect(contexts, activeContext) {
  knownContexts = contexts;
  const previousValue = addContextSelect.value;
  const hasPrevious = contexts.some((c) => String(c.id) === previousValue);

  addContextSelect.innerHTML = contexts
    .map((c) => `<option value="${c.id}">${escapeHtml(c.nome)}</option>`)
    .join('');

  if (hasPrevious) {
    addContextSelect.value = previousValue;
  } else if (activeContext) {
    addContextSelect.value = String(activeContext.id);
  }
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

// --- Adicionar música direto (busca independente da fila, não é afetada pelo auto-refresh) ---

function renderAddResults(resultados) {
  if (!resultados.length) {
    addResultsEl.innerHTML = addLastQuery
      ? '<div class="empty-row">Nenhum resultado.</div>'
      : '';
    return;
  }

  addResultsEl.innerHTML = resultados
    .map(
      (r) => `
      <div class="add-result">
        <img src="${r.capaUrl || ''}" alt="" loading="lazy" />
        <div class="add-result__info">
          <div class="add-result__name">${escapeHtml(r.nome)}</div>
          <div class="add-result__artist">${escapeHtml(r.artista)}</div>
        </div>
        <button class="btn btn--primary" data-add-track-id="${r.trackId}"
                data-add-nome="${escapeHtml(r.nome)}"
                data-add-artista="${escapeHtml(r.artista)}"
                data-add-capa="${r.capaUrl || ''}"
                data-add-duracao="${r.duracaoMs || ''}">+ Adicionar</button>
      </div>`
    )
    .join('');
}

addSearchInput.addEventListener('input', () => {
  clearTimeout(addDebounceTimer);
  const q = addSearchInput.value.trim();
  addLastQuery = q;

  if (q.length < 2) {
    addResultsEl.innerHTML = '';
    return;
  }

  addDebounceTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (addLastQuery === q) renderAddResults(data.resultados || []);
    } catch {
      addResultsEl.innerHTML = '<div class="empty-row">Erro ao buscar.</div>';
    }
  }, 350);
});

addResultsEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-add-track-id]');
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = 'Adicionando…';

  try {
    const res = await fetch('/api/queue/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contextId: Number(addContextSelect.value),
        trackId: btn.dataset.addTrackId,
        nome: btn.dataset.addNome,
        artista: btn.dataset.addArtista,
        capaUrl: btn.dataset.addCapa,
        duracaoMs: Number(btn.dataset.addDuracao) || null,
      }),
    });
    if (res.ok) {
      btn.textContent = 'Adicionada ✓';
      loadQueue();
    } else {
      btn.disabled = false;
      btn.textContent = '+ Adicionar';
    }
  } catch {
    btn.disabled = false;
    btn.textContent = '+ Adicionar';
  }
});