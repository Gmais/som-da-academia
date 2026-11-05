'use strict';

/*
 * Painel do staff.
 *
 * Modelo: todas as telas leem o MESMO estado do servidor (GET /api/player) e controlam o som
 * chamando o servidor. Só a tela marcada como "Player Oficial" cria o player do Spotify
 * (Web Playback SDK) e faz o som sair; ela apenas reporta posição/pausa e avisa quando a
 * música está acabando. Ela nunca decide sozinha o que tocar — por isso não há mais
 * disputa entre telas nem música "voltando ao começo".
 */

const CFG = {
  POLL_PLAYER_MS: 3000,    // estado do player (música atual, próxima, posição, volume, quem é o oficial)
  POLL_QUEUE_MS: 15000,    // listas de músicas
  POLL_SPOTIFY_MS: 20000,  // conexão com a conta Spotify
  TICK_MS: 1000,           // progresso na tela + (no oficial) leitura do SDK
  REPORT_MS: 4000,         // o oficial reporta posição/sinal de vida ao servidor
  ANTECIPAR_FIM_MS: 5000,  // passa para a próxima faltando 5s (evita o silêncio entre músicas). 0 = só no fim.
  MIN_DURACAO_ANTECIPAR_MS: 20000,
};

const NOME_LISTA_PEDIDOS = 'Pedidos de Alunos';

const $ = (id) => document.getElementById(id);
const strips = $('strips');
const activeBanner = $('active-context-name');
const clockEl = $('clock');
const contextEditor = $('context-editor');
const qrImg = $('qr-img');
const addContextSelect = $('add-context-select');
const addSearchInput = $('add-search-input');
const addResultsEl = $('add-results');
const importContextSelect = $('import-context-select');
const importTextArea = $('import-text-area');
const importTextBtn = $('import-text-btn');
const importTextStatus = $('import-text-status');
const spotifyStatusEl = $('spotify-status');
const spotifyConnectBtn = $('spotify-connect-btn');
const spotifyDisconnectBtn = $('spotify-disconnect-btn');
const officialBtn = $('official-player-btn');
const volumeSlider = $('volume-slider');
const volumeValueEl = $('volume-value');
const volumeIconEl = $('volume-icon');
const nowPlayingEl = $('now-playing');
const toastEl = $('toast');

// ---------------------------------------------------------------- utilidades

function escapeHtml(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDuration(ms) {
  if (!ms) return '--:--';
  return fmtClockMs(ms);
}

function fmtClockMs(ms) {
  const totalSec = Math.max(0, Math.floor(Number(ms) / 1000));
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
}

function levelDots(naFila, max = 5) {
  const on = Math.min(naFila, max);
  return Array.from({ length: max }, (_, i) => `<span class="${i < on ? 'on' : ''}"></span>`).join('');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let toastTimer = null;
function toast(msg, tipo = 'ok') {
  toastEl.textContent = msg;
  toastEl.className = tipo === 'erro' ? 'toast toast--error' : 'toast';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, tipo === 'erro' ? 7000 : 4000);
}

// Nunca lança: erro de rede vira { ok:false, status:0 }
async function api(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* corpo vazio */ }
    return { ok: res.ok, status: res.status, data: data || {} };
  } catch {
    return { ok: false, status: 0, data: { erro: 'Sem conexão com o servidor.' } };
  }
}

// ------------------------------------------------- identidade desta tela

const CHANNEL_NAME = 'sda_official_player';
const channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL_NAME) : null;

function newClientId() {
  return (window.crypto && crypto.randomUUID && crypto.randomUUID()) || `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Identifica esta aba (sobrevive a recarregar; não é compartilhada entre abas)
function readClientId() {
  try {
    let id = sessionStorage.getItem('sda_client_id');
    if (!id) {
      id = newClientId();
      sessionStorage.setItem('sda_client_id', id);
    }
    return id;
  } catch {
    return newClientId();
  }
}

let clientId = readClientId();

if (channel) {
  channel.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.t === 'whois' && m.id === clientId) channel.postMessage({ t: 'iam', id: clientId });
    if (m.t === 'changed') pollPlayer(true);
  });
}

// "Duplicar aba" copia o sessionStorage — duas abas com o mesmo id se achariam, as duas, Player Oficial.
async function ensureUniqueClientId() {
  if (!channel) return;
  let clash = false;
  const onMsg = (ev) => {
    if (ev.data && ev.data.t === 'iam' && ev.data.id === clientId) clash = true;
  };
  channel.addEventListener('message', onMsg);
  channel.postMessage({ t: 'whois', id: clientId });
  await sleep(250);
  channel.removeEventListener('message', onMsg);
  if (clash) {
    clientId = newClientId();
    try { sessionStorage.setItem('sda_client_id', clientId); } catch { /* sem storage */ }
  }
}

// ------------------------------------------------------------------ estado

let spotifyChecked = false;
let spotifyConnected = false;
let sdkReady = Boolean(window.__sdkReady);
let spotifyPlayer = null;   // Spotify.Player — só existe na tela oficial
let sdkDeviceId = null;
let playerError = null;     // mensagem de erro do SDK nesta tela
let isOfficial = false;
let officialOwnerId = null;

let snap = null;            // último GET /api/player + quando chegou (performance.now)
let lastQueue = null;       // último GET /api/queue
let viewingContextId = null; // null = lista padrão (Pedidos de Alunos)

const clearingContexts = new Set(); // listas cujo "Excluir todas" está em andamento

// ------------------------------------------------------- estado do player

function snapPositionMs() {
  if (!snap || !snap.nowPlaying) return 0;
  let pos = Number(snap.positionMs) || 0;
  if (!snap.paused) pos += performance.now() - snap.at;
  const dur = snap.durationMs || snap.nowPlaying.duracaoMs || 0;
  return dur > 0 ? Math.min(pos, dur) : pos;
}

let pollInFlight = null;
// fresh = true: depois de uma ação, uma consulta já em andamento pode trazer o estado de ANTES dela.
function pollPlayer(fresh = false) {
  if (pollInFlight) {
    return fresh ? pollInFlight.then(() => pollPlayer()) : pollInFlight;
  }
  pollInFlight = (async () => {
    const r = await api('GET', '/api/player');
    if (r.ok) applyPlayer(r.data);
    return r.ok ? r.data : null;
  })().finally(() => { pollInFlight = null; });
  return pollInFlight;
}

function applyPlayer(data) {
  const prevId = snap && snap.nowPlaying ? snap.nowPlaying.id : null;
  snap = { ...data, at: performance.now() };
  officialOwnerId = data.ownerId || null;

  const nowOfficial = officialOwnerId === clientId;
  if (nowOfficial !== isOfficial) {
    isOfficial = nowOfficial;
    applyOfficialRole();
  }

  const curId = data.nowPlaying ? data.nowPlaying.id : null;
  if (curId !== prevId) {
    advancingFor = null;     // música nova: libera um novo "acabou"
    loadQueue();             // os status nas listas mudaram
  }

  renderWidget();
  renderStatus();
  renderVolume();
  renderRowStates();
  syncOfficialVolume();
}

// ------------------------------------------------------------ renderização

function renderWidget() {
  const np = snap && snap.nowPlaying;
  nowPlayingEl.hidden = !np;
  if (!np) return;

  $('now-playing-title').textContent = np.nome || '—';
  $('now-playing-artist').textContent = np.artista || '—';
  const cover = $('now-playing-cover');
  if (np.capaUrl) { cover.src = np.capaUrl; cover.hidden = false; } else { cover.removeAttribute('src'); cover.hidden = true; }

  const label = snap.paused ? (snap.online || !snap.ownerId ? 'Pausada' : 'Player Oficial offline') : 'Tocando agora';
  $('now-playing-label').textContent = label;
  $('now-playing-toggle').textContent = snap.paused ? '▶' : '⏸';
  $('now-playing-toggle').title = snap.paused ? 'Continuar' : 'Pausar';

  const next = snap.next;
  $('now-playing-next-title').textContent = next ? next.nome : '—';
  $('now-playing-next-artist').textContent = next ? next.artista : (np ? 'fim da lista' : '—');
  const nextCover = $('now-playing-next-cover');
  if (next && next.capaUrl) { nextCover.src = next.capaUrl; nextCover.hidden = false; } else { nextCover.removeAttribute('src'); nextCover.hidden = true; }
  $('now-playing-next-delete').hidden = !next;

  updateProgressUi();
}

function updateProgressUi() {
  if (!snap || !snap.nowPlaying) return;
  const dur = snap.durationMs || snap.nowPlaying.duracaoMs || 0;
  const pos = snapPositionMs();
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;

  $('now-playing-progress').style.width = `${pct}%`;
  $('now-playing-time').textContent = fmtClockMs(pos);
  $('now-playing-duration').textContent = dur ? fmtClockMs(dur) : '--:--';

  const fill = document.getElementById(`progress-${snap.nowPlaying.id}`);
  if (fill) fill.style.width = `${pct}%`;
}

// Rótulo do botão principal da linha que está tocando (Pausar/Continuar)
function renderRowStates() {
  const paused = Boolean(snap && snap.paused);
  document.querySelectorAll('.track-row[data-status="tocando"] [data-row-play]').forEach((btn) => {
    btn.textContent = paused ? '▶ Continuar' : '⏸ Pausar';
  });
}

function renderStatus() {
  let html;
  if (!spotifyChecked) {
    html = 'verificando conexão com o Spotify…';
  } else if (!spotifyConnected) {
    html = 'Spotify ainda não conectado.';
  } else if (isOfficial) {
    if (playerError) html = playerError;
    else if (sdkDeviceId) html = 'Spotify conectado — <strong>player pronto ✓</strong> (o som sai desta tela)';
    else html = 'Spotify conectado — <strong>carregando player…</strong>';
  } else if (officialOwnerId) {
    if (snap && snap.online) html = 'Spotify conectado — <strong>o som toca em outra tela</strong> (esta só controla)';
    else if (snap && !snap.deviceReady) html = 'Spotify conectado — <strong>o Player Oficial está carregando…</strong>';
    else html = 'Spotify conectado — <strong>o Player Oficial está offline</strong>. Abra a tela oficial ou ative "Player Oficial" aqui.';
  } else {
    html = 'Spotify conectado — <strong>nenhuma tela é o Player Oficial</strong>. Ative "Player Oficial: ON" na tela que vai tocar.';
  }
  spotifyStatusEl.innerHTML = html;

  spotifyConnectBtn.hidden = !spotifyChecked || spotifyConnected;
  spotifyDisconnectBtn.hidden = !spotifyConnected;
  officialBtn.textContent = `Player Oficial: ${isOfficial ? 'ON' : 'OFF'}`;
  officialBtn.setAttribute('aria-pressed', String(isOfficial));
}

function renderTrackRow(item) {
  const isPlaying = item.status === 'tocando';
  const isPlayed = item.status === 'tocada';
  const paused = isPlaying && snap && snap.paused;

  const playLabel = isPlaying ? (paused ? '▶ Continuar' : '⏸ Pausar') : isPlayed ? '↺ Tocar de novo' : '▶ Tocar';
  let secondary = '';
  if (isPlaying) {
    secondary = '<button class="btn btn--ghost" data-skip title="Pular para a próxima música">Pular ⏭</button>';
  } else if (isPlayed) {
    secondary = `<button class="btn btn--ghost" data-action="pendente" data-id="${item.id}">colocar na fila</button>`;
  }

  return `
    <div class="track-row" data-status="${escapeHtml(item.status)}" data-id="${item.id}" data-track-id="${escapeHtml(item.track_id)}">
      ${item.capa_url ? `<img class="track-row__cover" src="${escapeHtml(item.capa_url)}" alt="" loading="lazy" />` : '<div class="track-row__cover"></div>'}
      <div class="track-row__info">
        <div class="track-row__name">${escapeHtml(item.nome)}</div>
        <div class="track-row__artist">
          ${escapeHtml(item.artista)}
          ${item.matricula ? `<span class="track-row__matricula" title="Sugerido pelo aluno de matrícula ${escapeHtml(item.matricula)}">👤 ${escapeHtml(item.matricula)}</span>` : ''}
        </div>
      </div>
      <div class="track-progress">
        <div class="track-progress__fill" id="progress-${item.id}"></div>
      </div>
      <div class="track-row__duration">${fmtDuration(Number(item.duracao_ms))}</div>
      <div class="track-row__actions">
        <button class="btn btn--primary" data-row-play="${item.id}">${playLabel}</button>
        ${secondary}
        <a class="btn btn--ghost" href="https://open.spotify.com/search/${encodeURIComponent(item.nome + ' ' + item.artista)}" target="_blank" rel="noopener" title="Abrir busca no Spotify (manual)">↗</a>
        <button class="btn btn--danger" data-action="removida" data-id="${item.id}">Remover</button>
      </div>
    </div>
  `;
}

let stripsSig = '';
function renderStrips(force) {
  const data = lastQueue;
  if (!data) return;
  const sig = JSON.stringify([data, [...clearingContexts]]);
  if (!force && sig === stripsSig) return;
  stripsSig = sig;

  activeBanner.textContent = data.activeContext ? data.activeContext.nome : 'nenhum contexto configurado';

  strips.innerHTML = data.contexts
    .map((ctx) => {
      const isViewing = ctx.id === data.viewingContextId;
      const isActiveContext = data.activeContext && ctx.id === data.activeContext.id;
      const clearing = clearingContexts.has(ctx.id);
      const clearBtn = `<button class="btn btn--danger" style="margin-left: 8px" data-clear-context="${ctx.id}" ${clearing ? 'disabled' : ''} title="Exclui para sempre todas as músicas desta lista">${clearing ? 'Excluindo…' : 'Excluir todas as músicas'}</button>`;

      const body = isViewing
        ? `<div class="strip__body" data-body>
             ${data.items.length ? data.items.map(renderTrackRow).join('') : '<div class="empty-row">Nenhuma música na fila ainda.' + (isActiveContext ? ' Compartilhe o QR code com os alunos.' : '') + '</div>'}
           </div>`
        : '<div class="strip__body" hidden></div>';

      return `
        <div class="strip ${isActiveContext ? 'strip--active' : ''}" style="--strip-color:${escapeHtml(ctx.cor)}" data-context-id="${ctx.id}">
          <div class="strip__header" data-toggle="${ctx.id}">
            <span class="strip__name">${escapeHtml(ctx.nome)}</span>
            <span class="strip__meta">
              <span class="level">${levelDots(ctx.naFila)}</span>
              <span class="strip__count">${ctx.naFila} na fila</span>
              <label class="toggle-random" title="Tocar as músicas desta lista de forma aleatória (vale para todas as telas)">
                <input type="checkbox" data-random-context="${ctx.id}" class="random-checkbox" ${ctx.aleatorio ? 'checked' : ''} />
                <span class="random-label">Tocar Aleatório</span>
              </label>
              ${clearBtn}
            </span>
          </div>
          ${body}
        </div>
      `;
    })
    .join('');

  renderContextEditor(data.contexts);
  renderSelects(data.contexts, data.activeContext);
  renderRowStates();
  updateProgressUi();
}

let selectsSig = '';
function renderSelects(contexts, activeContext) {
  const sig = JSON.stringify(contexts.map((c) => [c.id, c.nome]));
  if (sig === selectsSig) return;   // recriar as opções fecharia o menu aberto
  selectsSig = sig;

  const previousAdd = addContextSelect.value;
  const previousImport = importContextSelect.value;
  const options = contexts.map((c) => `<option value="${c.id}">${escapeHtml(c.nome)}</option>`).join('');

  for (const [select, previous] of [[addContextSelect, previousAdd], [importContextSelect, previousImport]]) {
    select.innerHTML = options;
    if (contexts.some((c) => String(c.id) === previous)) select.value = previous;
    else if (activeContext) select.value = String(activeContext.id);
  }
}

let editorSig = '';
let editorPending = null;
function renderContextEditor(contexts) {
  const sig = JSON.stringify(contexts.map((c) => [c.id, c.nome, c.ordem]));
  if (sig === editorSig) return;
  // Não troca os campos enquanto alguém está digitando um nome
  if (contextEditor.contains(document.activeElement)) { editorPending = contexts; return; }
  editorSig = sig;
  editorPending = null;

  contextEditor.innerHTML = contexts
    .map((ctx) => {
      const fixa = ctx.nome === NOME_LISTA_PEDIDOS;
      return `
      <div class="ctx-edit-row" data-ctx-id="${ctx.id}" style="display:flex; gap:4px; align-items:center;">
        <button class="btn btn--ghost" data-move-context="-1" title="Subir" style="padding: 4px; margin: 0; min-height: 0;">▲</button>
        <button class="btn btn--ghost" data-move-context="1" title="Descer" style="padding: 4px; margin: 0; min-height: 0;">▼</button>
        <input type="text" value="${escapeHtml(ctx.nome)}" data-field="nome" style="flex:1" ${fixa ? 'readonly title="Lista fixa: recebe os pedidos do QR code"' : ''} />
        ${fixa ? '<span style="width:30px"></span>' : `<button class="btn btn--danger" data-delete-context="${ctx.id}" title="Excluir contexto" style="padding: 4px 8px; margin: 0;">✕</button>`}
      </div>`;
    })
    .join('');
}

contextEditor.addEventListener('focusout', () => {
  if (!editorPending) return;
  setTimeout(() => {
    if (editorPending && !contextEditor.contains(document.activeElement)) renderContextEditor(editorPending);
  }, 0);
});

// ------------------------------------------------------------------- filas

let queueInFlight = null;
let queueDirty = false;
function loadQueue() {
  if (queueInFlight) { queueDirty = true; return queueInFlight; }
  queueInFlight = (async () => {
    do {
      queueDirty = false;
      const qs = viewingContextId ? `?contextId=${viewingContextId}` : '';
      const r = await api('GET', `/api/queue${qs}`);
      if (!r.ok) break;
      lastQueue = r.data;
      // lista aberta foi excluída em outra tela: volta para a padrão
      if (viewingContextId && !lastQueue.contexts.some((c) => c.id === viewingContextId)) {
        viewingContextId = null;
        queueDirty = true;
        continue;
      }
      renderStrips();
    } while (queueDirty);
  })().finally(() => { queueInFlight = null; });
  return queueInFlight;
}

async function refreshAll() {
  await pollPlayer(true);
  await loadQueue();
}

// Executa uma ação de controle e mostra o erro (mensagem do servidor) se falhar
async function control(method, url, body) {
  const r = await api(method, url, body);
  if (!r.ok) {
    toast(r.data.erro || 'Não foi possível executar o comando.', 'erro');
  } else {
    if (r.data.aviso) toast(r.data.aviso, 'erro');
    const puladas = (r.data.puladas || (r.data.avanco && r.data.avanco.puladas) || []);
    if (puladas.length) toast(`Não achei no Spotify e pulei: ${puladas.join(', ')}`, 'erro');
  }
  await refreshAll();
  return r;
}

// -------------------------------------------------------------- eventos: listas

strips.addEventListener('click', async (e) => {
  const clearBtn = e.target.closest('[data-clear-context]');
  if (clearBtn) {
    if (clearBtn.disabled) return;
    const contextId = Number(clearBtn.dataset.clearContext);
    const ctx = lastQueue && lastQueue.contexts.find((c) => c.id === contextId);
    const nome = ctx ? ctx.nome : 'esta lista';
    const tocandoAqui = snap && snap.nowPlaying && snap.nowPlaying.contextId === contextId;
    const aviso = tocandoAqui ? `\n\nA música que está tocando agora vai parar.` : '';
    if (!confirm(`Excluir TODAS as músicas de "${nome}"?\n\nElas saem da lista para sempre (não voltam no outro dia) e isso não pode ser desfeito.${aviso}`)) return;

    clearingContexts.add(contextId);
    renderStrips(true);
    const r = await api('DELETE', `/api/queue/context/${contextId}`);
    clearingContexts.delete(contextId);
    if (r.ok) {
      const n = r.data.excluidas || 0;
      toast(n ? `${n} ${n === 1 ? 'música excluída' : 'músicas excluídas'} de "${nome}".` : `"${nome}" já estava vazia.`);
    } else {
      toast(r.data.erro || 'Não foi possível excluir as músicas.', 'erro');
    }
    await refreshAll();
    renderStrips(true);
    return;
  }

  if (e.target.closest('.toggle-random')) return; // o checkbox trata no evento "change"

  const rowPlay = e.target.closest('[data-row-play]');
  if (rowPlay) {
    if (rowPlay.disabled) return;
    const row = rowPlay.closest('.track-row');
    rowPlay.disabled = true;
    try {
      if (row.dataset.status === 'tocando') {
        await control('POST', snap && snap.paused ? '/api/player/resume' : '/api/player/pause');
      } else {
        await control('POST', '/api/player/play', { itemId: Number(rowPlay.dataset.rowPlay) });
      }
    } finally {
      rowPlay.disabled = false;
    }
    return;
  }

  if (e.target.closest('[data-skip]')) {
    const btn = e.target.closest('[data-skip]');
    btn.disabled = true;
    await control('POST', '/api/player/next');
    return;
  }

  const actionBtn = e.target.closest('[data-action]');
  if (actionBtn) {
    actionBtn.disabled = true;
    await control('PATCH', `/api/queue/${actionBtn.dataset.id}`, { status: actionBtn.dataset.action });
    return;
  }

  // clique no cabeçalho (fora dos controles): abre/fecha a lista
  const toggle = e.target.closest('[data-toggle]');
  if (toggle && !e.target.closest('button, a, label, input')) {
    const id = Number(toggle.dataset.toggle);
    viewingContextId = lastQueue && lastQueue.viewingContextId === id ? null : id;
    loadQueue();
  }
});

strips.addEventListener('change', async (e) => {
  if (!e.target.classList.contains('random-checkbox')) return;
  const contextId = Number(e.target.dataset.randomContext);
  const checked = e.target.checked;
  const r = await api('PATCH', `/api/contexts/${contextId}`, { aleatorio: checked });
  if (!r.ok) {
    e.target.checked = !checked;
    toast(r.data.erro || 'Não foi possível mudar o modo aleatório.', 'erro');
  }
  await refreshAll();
});

contextEditor.addEventListener('change', async (e) => {
  const row = e.target.closest('[data-ctx-id]');
  if (!row || e.target.readOnly) return;
  const payload = {};
  row.querySelectorAll('[data-field]').forEach((input) => {
    payload[input.dataset.field] = input.value;
  });
  const r = await api('PATCH', `/api/contexts/${row.dataset.ctxId}`, payload);
  if (!r.ok) toast(r.data.erro || 'Não foi possível renomear.', 'erro');
  editorSig = ''; // força releitura do nome salvo
  loadQueue();
});

contextEditor.addEventListener('click', async (e) => {
  const moveBtn = e.target.closest('[data-move-context]');
  if (moveBtn) {
    const dir = parseInt(moveBtn.dataset.moveContext, 10);
    const row = moveBtn.closest('.ctx-edit-row');
    const allRows = Array.from(contextEditor.querySelectorAll('.ctx-edit-row'));
    const index = allRows.indexOf(row);
    if (index === -1) return;

    if (dir === -1 && index > 0) {
      contextEditor.insertBefore(row, allRows[index - 1]);
    } else if (dir === 1 && index < allRows.length - 1) {
      contextEditor.insertBefore(row, allRows[index + 2] || null);
    } else {
      return;
    }

    const newOrder = Array.from(contextEditor.querySelectorAll('.ctx-edit-row')).map((r) => Number(r.dataset.ctxId));
    const r = await api('POST', '/api/contexts/reorder', { order: newOrder });
    if (!r.ok) toast('Erro ao reordenar.', 'erro');
    editorSig = '';
    loadQueue();
    return;
  }

  const deleteBtn = e.target.closest('[data-delete-context]');
  if (deleteBtn) {
    const id = Number(deleteBtn.dataset.deleteContext);
    if (!confirm('Tem certeza que quer excluir este contexto? Todas as músicas na fila dele serão perdidas.')) return;
    deleteBtn.disabled = true;
    const r = await api('DELETE', `/api/contexts/${id}`);
    if (r.ok) {
      if (viewingContextId === id) viewingContextId = null;
      editorSig = '';
      await refreshAll();
    } else {
      toast(r.data.erro || 'Falha ao excluir.', 'erro');
      deleteBtn.disabled = false;
    }
  }
});

$('add-context-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Adicionando...';
  const r = await api('POST', '/api/contexts', {
    nome: 'Nova Categoria',
    cor: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'), // cor aleatória
  });
  if (r.ok) loadQueue();
  else toast(r.data.erro || 'Falha ao criar contexto.', 'erro');
  btn.disabled = false;
  btn.textContent = '+ Novo Contexto';
});

// -------------------------------------------------- eventos: player (todas as telas)

nowPlayingEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-np-action]');
  if (!btn || btn.disabled || !snap || !snap.nowPlaying) return;
  const action = btn.dataset.npAction;
  btn.disabled = true;
  try {
    if (action === 'toggle') {
      await control('POST', snap.paused ? '/api/player/resume' : '/api/player/pause');
    } else if (action === 'skip') {
      await control('POST', '/api/player/next');
    } else if (action === 'delete') {
      if (!confirm(`Excluir "${snap.nowPlaying.nome}" da lista e tocar a próxima?`)) return;
      await control('PATCH', `/api/queue/${snap.nowPlaying.id}`, { status: 'removida' });
    } else if (action === 'delete-next' && snap.next) {
      if (!confirm(`Excluir a próxima música ("${snap.next.nome}") da lista?`)) return;
      await control('PATCH', `/api/queue/${snap.next.id}`, { status: 'removida' });
    }
  } finally {
    btn.disabled = false;
  }
});

// Volume: vale para o Player Oficial, de qualquer tela
let volumeDragging = false;
let volumeHoldUntil = 0;
let volumeTimer = null;

function volumeIcon(pct) {
  if (pct === 0) return '🔇';
  if (pct < 50) return '🔉';
  return '🔊';
}

function setVolumeUi(pct) {
  volumeSlider.value = String(pct);
  volumeValueEl.textContent = `${pct}%`;
  volumeIconEl.textContent = volumeIcon(pct);
}

function renderVolume() {
  if (!snap || volumeDragging || performance.now() < volumeHoldUntil) return;
  setVolumeUi(snap.volume);
}

volumeSlider.addEventListener('input', () => {
  const pct = Number(volumeSlider.value);
  volumeDragging = true;
  setVolumeUi(pct);
  if (spotifyPlayer) spotifyPlayer.setVolume(pct / 100); // feedback imediato na tela oficial

  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(async () => {
    const r = await api('PUT', '/api/player/volume', { volumePercent: pct });
    volumeDragging = false;
    volumeHoldUntil = performance.now() + 2500; // dá tempo do servidor devolver o novo valor
    if (!r.ok) toast(r.data.erro || 'Não foi possível mudar o volume.', 'erro');
  }, 250);
});

// Na tela oficial, garante que o SDK está no volume combinado (caso o comando do Spotify não tenha chegado)
async function syncOfficialVolume() {
  if (!spotifyPlayer || !snap || volumeDragging || performance.now() < volumeHoldUntil) return;
  try {
    const current = await spotifyPlayer.getVolume();
    if (typeof current === 'number' && Math.abs(current * 100 - snap.volume) > 2) {
      spotifyPlayer.setVolume(snap.volume / 100);
    }
  } catch { /* SDK ainda carregando */ }
}

// ------------------------------------------------------- Player Oficial: ligar/desligar

officialBtn.addEventListener('click', async () => {
  officialBtn.disabled = true;
  const turningOn = !isOfficial;
  const r = await api(turningOn ? 'PUT' : 'DELETE', '/api/player/official', { clientId });
  officialBtn.disabled = false;
  if (!r.ok) {
    toast(r.data.erro || 'Não foi possível alterar o Player Oficial.', 'erro');
    return;
  }
  if (channel) channel.postMessage({ t: 'changed' }); // avisa as outras abas deste navegador na hora
  await pollPlayer(true);                              // aplica o novo dono (liga/desliga o player local)
  if (turningOn) activatePlayerElement();
});

function activatePlayerElement() {
  try {
    if (spotifyPlayer && typeof spotifyPlayer.activateElement === 'function') spotifyPlayer.activateElement();
  } catch { /* navegador sem suporte */ }
}
// Alguns navegadores só liberam o áudio depois de um clique na própria página
document.addEventListener('pointerdown', activatePlayerElement, { passive: true });

function applyOfficialRole() {
  if (isOfficial) {
    playerError = null;
    maybeStartPlayer();
  } else {
    stopLocalPlayer();
  }
  renderStatus();
}

function stopLocalPlayer() {
  if (spotifyPlayer) {
    try { spotifyPlayer.disconnect(); } catch { /* já desconectado */ }
  }
  spotifyPlayer = null;
  sdkDeviceId = null;
  lastSdk = null;
  prevSdk = null;
  playerError = null;
}

// ------------------------------------------------------- Player Oficial: SDK do Spotify

window.__onSdkReady = () => {
  sdkReady = true;
  maybeStartPlayer();
};

let lastSdk = null;    // último estado lido do SDK (normalizado)
let prevSdk = null;
let lastReportAt = 0;
let advancingFor = null;
let earlyDisabledFor = null;
const advanceTries = {};

// A faixa terminou: parada na posição 0 com ela mesma na lista de "anteriores"
function isEndedState(s) {
  return Boolean(s && s.paused && s.position === 0 && s.previousIds.includes(s.currentId));
}

function normalizeSdkState(state) {
  if (!state || !state.track_window || !state.track_window.current_track) return null;
  const cur = state.track_window.current_track;
  return {
    position: state.position,
    duration: state.duration,
    paused: state.paused,
    uri: cur.uri,
    linked: cur.linked_from ? cur.linked_from.uri : null,
    currentId: cur.id,
    previousIds: (state.track_window.previous_tracks || []).map((t) => t.id),
  };
}

// O estado do SDK é da música que ele está tocando; só vale se for a que o servidor diz estar no ar
function sdkMatchesNowPlaying(s) {
  const np = snap && snap.nowPlaying;
  if (!s || !np || !np.spotifyUri) return false;
  return s.uri === np.spotifyUri || s.linked === np.spotifyUri;
}

function maybeStartPlayer() {
  if (!sdkReady || !spotifyConnected || !isOfficial || spotifyPlayer || !window.Spotify) return;

  const player = new Spotify.Player({
    name: 'Som da Academia',
    getOAuthToken: async (callback) => {
      const r = await api('GET', '/api/spotify/token');
      callback(r.data.accessToken || '');
    },
    volume: (snap ? snap.volume : 80) / 100,
  });
  spotifyPlayer = player;
  const mine = () => spotifyPlayer === player; // ignora eventos de um player já desligado

  player.addListener('ready', ({ device_id }) => {
    if (!mine()) return;
    sdkDeviceId = device_id;
    playerError = null;
    registerDevice(device_id);
    renderStatus();
  });
  player.addListener('not_ready', () => {
    if (!mine()) return;
    sdkDeviceId = null;
    renderStatus();
  });
  player.addListener('authentication_error', () => {
    if (!mine()) return;
    playerError = 'Erro de autenticação com o Spotify. Tente reconectar.';
    spotifyConnectBtn.hidden = false;
    renderStatus();
  });
  player.addListener('account_error', () => {
    if (!mine()) return;
    playerError = '<strong>Essa conta do Spotify não é Premium</strong> — o player de verdade exige Premium na conta conectada.';
    renderStatus();
  });
  player.addListener('initialization_error', ({ message }) => {
    if (!mine()) return;
    playerError = 'Não foi possível iniciar o player neste navegador: ' + escapeHtml(message);
    renderStatus();
  });
  player.addListener('player_state_changed', (state) => {
    if (!mine()) return;
    onSdkState(normalizeSdkState(state));
  });

  player.connect();
  activatePlayerElement();
}

// Avisa o servidor qual é o device desta tela; se a música estava tocando, ele a retoma aqui
async function registerDevice(deviceId, tentativa = 0) {
  const r = await api('PUT', '/api/player/device', { clientId, deviceId });
  if (r.status === 403) return; // perdeu o posto de oficial
  if (!r.ok) {
    if (tentativa < 5 && sdkDeviceId === deviceId) {
      await sleep(2000);
      if (sdkDeviceId === deviceId) registerDevice(deviceId, tentativa + 1);
    } else {
      toast('Não consegui registrar o Player Oficial no servidor.', 'erro');
    }
    return;
  }
  await refreshAll();
}

function onSdkState(s) {
  const before = prevSdk;
  prevSdk = s;
  lastSdk = s;
  if (!s) return;

  // Fim natural da faixa: estava tocando e parou na posição 0 com a própria faixa em "anteriores"
  if (before && !before.paused && isEndedState(s) && sdkMatchesNowPlaying(s)) {
    requestAdvance(snap.nowPlaying.id);
  }
  if (sdkMatchesNowPlaying(s)) {
    // pausou/continuou: reflete na hora nesta tela, sem esperar a próxima consulta ao servidor
    snap.positionMs = s.position;
    snap.durationMs = s.duration;
    snap.paused = s.paused;
    snap.at = performance.now();
    renderWidget();
    renderRowStates();
  }
  reportToServer(); // pausou, continuou ou trocou de faixa: as outras telas precisam saber já
}

// early = true: faltam poucos segundos (avanço antecipado). Se não houver próxima, a música toca até o fim.
async function requestAdvance(itemId, early = false) {
  if (advancingFor === itemId || (advanceTries[itemId] || 0) >= 3) return;
  if (early && earlyDisabledFor === itemId) return;
  advancingFor = itemId;
  const r = await api('POST', '/api/player/ended', { clientId, itemId, early });
  if (r.ok) {
    if (r.data.semProxima) {
      earlyDisabledFor = itemId; // última da lista: espera o fim de verdade (detectado abaixo)
      advancingFor = null;
    } else if (r.data.ignorado) {
      // o servidor achou cedo demais / já avançou: libera para tentar de novo, sem contar como falha
      setTimeout(() => { if (advancingFor === itemId) advancingFor = null; }, 1500);
    } else if (r.data.puladas && r.data.puladas.length) {
      toast(`Não achei no Spotify e pulei: ${r.data.puladas.join(', ')}`, 'erro');
    }
    await refreshAll();
  } else {
    advanceTries[itemId] = (advanceTries[itemId] || 0) + 1;
    toast(r.data.erro || 'Não foi possível passar para a próxima música.', 'erro');
    setTimeout(() => { if (advancingFor === itemId) advancingFor = null; }, 4000);
  }
}

async function reportToServer() {
  if (!isOfficial || !spotifyPlayer) return;
  lastReportAt = performance.now();
  const body = { clientId, deviceId: sdkDeviceId || undefined };
  if (lastSdk && sdkMatchesNowPlaying(lastSdk)) {
    body.positionMs = lastSdk.position;
    body.durationMs = lastSdk.duration;
    body.paused = lastSdk.paused;
  }
  const r = await api('POST', '/api/player/report', body);
  if (r.status === 403) pollPlayer(); // perdeu o posto de oficial
}

async function officialTick() {
  if (!isOfficial || !spotifyPlayer) return;
  let raw;
  try { raw = await spotifyPlayer.getCurrentState(); } catch { return; }
  const s = normalizeSdkState(raw);
  lastSdk = s;

  if (s && sdkMatchesNowPlaying(s)) {
    // progresso exato nesta tela
    snap.positionMs = s.position;
    snap.durationMs = s.duration;
    snap.paused = s.paused;
    snap.at = performance.now();

    const restante = s.duration - s.position;
    if (isEndedState(s)) {
      requestAdvance(snap.nowPlaying.id); // rede de segurança: o evento de fim do SDK não é garantido
    } else if (CFG.ANTECIPAR_FIM_MS > 0 && !s.paused && s.duration >= CFG.MIN_DURACAO_ANTECIPAR_MS && restante <= CFG.ANTECIPAR_FIM_MS) {
      requestAdvance(snap.nowPlaying.id, true);
    }
  }

  if (performance.now() - lastReportAt >= CFG.REPORT_MS) reportToServer();
}

// ------------------------------------------------------------- Spotify (conta)

async function checkSpotifyStatus() {
  const r = await api('GET', '/api/spotify/status');
  if (r.ok) {
    spotifyChecked = true;
    spotifyConnected = Boolean(r.data.connected);
    if (spotifyConnected) maybeStartPlayer();
  }
  renderStatus();
}

// ------------------------------------------------- adicionar música / importar

let addDebounceTimer = null;
let addLastQuery = '';

function renderAddResults(resultados) {
  if (!resultados.length) {
    addResultsEl.innerHTML = addLastQuery ? '<div class="empty-row">Nenhum resultado.</div>' : '';
    return;
  }

  addResultsEl.innerHTML = resultados
    .map(
      (r) => `
      <div class="add-result">
        <img src="${escapeHtml(r.capaUrl || '')}" alt="" loading="lazy" />
        <div class="add-result__info">
          <div class="add-result__name">${escapeHtml(r.nome)}</div>
          <div class="add-result__artist">${escapeHtml(r.artista)}</div>
        </div>
        <button class="btn btn--primary" data-add-track-id="${escapeHtml(r.trackId)}"
                data-add-nome="${escapeHtml(r.nome)}"
                data-add-artista="${escapeHtml(r.artista)}"
                data-add-capa="${escapeHtml(r.capaUrl || '')}"
                data-add-duracao="${escapeHtml(r.duracaoMs || '')}">+ Adicionar</button>
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
    const r = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
    if (addLastQuery !== q) return;
    if (r.ok) renderAddResults(r.data.resultados || []);
    else addResultsEl.innerHTML = '<div class="empty-row">Erro ao buscar.</div>';
  }, 350);
});

addResultsEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-add-track-id]');
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = 'Adicionando…';

  const r = await api('POST', '/api/queue/add', {
    contextId: Number(addContextSelect.value),
    trackId: btn.dataset.addTrackId,
    nome: btn.dataset.addNome,
    artista: btn.dataset.addArtista,
    capaUrl: btn.dataset.addCapa,
    duracaoMs: Number(btn.dataset.addDuracao) || null,
  });
  if (r.ok) {
    btn.textContent = 'Adicionada ✓';
    loadQueue();
  } else {
    toast(r.data.erro || 'Não foi possível adicionar.', 'erro');
    btn.disabled = false;
    btn.textContent = '+ Adicionar';
  }
});

importTextBtn.addEventListener('click', async () => {
  const contextId = Number(importContextSelect.value);
  const text = importTextArea.value.trim();

  if (!contextId) return toast('Selecione um contexto primeiro.', 'erro');
  if (!text) return toast('Cole uma lista de músicas primeiro.', 'erro');

  const queries = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (queries.length === 0) return;
  if (queries.length > 200) {
    return toast('Por favor, limite a 200 músicas por vez.', 'erro');
  }

  importTextBtn.disabled = true;
  importTextBtn.textContent = 'Buscando e Importando...';
  importTextStatus.textContent = 'Isso pode levar alguns segundos...';

  const r = await api('POST', '/api/spotify/mass-import-text', { contextId, queries });
  if (r.ok) {
    const d = r.data;
    let msg = `✅ ${d.importedCount} de ${d.total} músicas adicionadas.`;
    if (d.duplicadas) msg += ` ${d.duplicadas} já estavam na lista.`;
    if (d.naoEncontradas && d.naoEncontradas.length) msg += ` Não encontradas: ${d.naoEncontradas.slice(0, 5).join('; ')}${d.naoEncontradas.length > 5 ? '…' : ''}.`;
    if (d.falhas) msg += ` ${d.falhas} falharam na busca — tente de novo.`;
    importTextStatus.textContent = msg;
    if (!d.falhas) importTextArea.value = '';
    loadQueue();
  } else {
    importTextStatus.textContent = '';
    toast(r.data.erro || 'Falha ao importar lista.', 'erro');
  }
  importTextBtn.disabled = false;
  importTextBtn.textContent = 'Importar Lista';
});

// ------------------------------------------------------------------- relógio / boot

function tickClock() {
  clockEl.textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function readSpotifyParams() {
  const params = new URLSearchParams(location.search);
  if (params.has('spotify_conectado')) toast('Spotify conectado!');
  if (params.has('spotify_erro')) toast('Não foi possível conectar o Spotify (' + params.get('spotify_erro') + ').', 'erro');
  if (params.has('spotify_conectado') || params.has('spotify_erro')) {
    history.replaceState(null, '', location.pathname);
  }
}

async function boot() {
  await ensureUniqueClientId();
  qrImg.src = '/api/qrcode?' + Date.now();
  tickClock();
  readSpotifyParams();

  await Promise.all([checkSpotifyStatus(), pollPlayer(), loadQueue()]);

  setInterval(tickClock, 10000);
  setInterval(pollPlayer, CFG.POLL_PLAYER_MS);
  setInterval(loadQueue, CFG.POLL_QUEUE_MS);
  setInterval(checkSpotifyStatus, CFG.POLL_SPOTIFY_MS);
  setInterval(() => {
    updateProgressUi();
    officialTick();
  }, CFG.TICK_MS);
}

boot();
