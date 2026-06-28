const strips = document.getElementById('strips');
const activeBanner = document.getElementById('active-context-name');
const clockEl = document.getElementById('clock');
const contextEditor = document.getElementById('context-editor');
const qrImg = document.getElementById('qr-img');
const addContextSelect = document.getElementById('add-context-select');
const addSearchInput = document.getElementById('add-search-input');
const addResultsEl = document.getElementById('add-results');
const importContextSelect = document.getElementById('import-context-select');
const choosePlaylistBtn = document.getElementById('choose-playlist-btn');
const choosePlaylistStatus = document.getElementById('choose-playlist-status');
const playlistModal = document.getElementById('playlist-modal');
const playlistModalList = document.getElementById('playlist-modal-list');
const playlistModalClose = document.getElementById('playlist-modal-close');
const spotifyStatusEl = document.getElementById('spotify-status');
const spotifyConnectBtn = document.getElementById('spotify-connect-btn');
const spotifyDisconnectBtn = document.getElementById('spotify-disconnect-btn');
const spotifyPauseBtn = document.getElementById('spotify-pause-btn');

let spotifyDeviceId = null;
let spotifyPlayer = null;

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
        <button class="btn btn--primary" data-play-id="${item.id}" ${spotifyDeviceId ? '' : 'disabled title="Conecte o Spotify e espere o player ficar pronto"'}>▶ Tocar</button>
        ${!isPlaying ? `<button class="btn btn--ghost" data-action="tocando" data-id="${item.id}">marcar tocando</button>` : `<button class="btn btn--ghost" data-action="tocada" data-id="${item.id}">marcar tocada</button>`}
        <a class="btn btn--ghost" href="https://open.spotify.com/search/${encodeURIComponent(item.nome + ' ' + item.artista)}" target="_blank" rel="noopener" title="Abrir busca no Spotify (manual)">↗</a>
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
              <button class="btn btn--primary" style="margin-left: 8px" data-create-playlist="${ctx.id}" title="Transforma a fila desse contexto em uma playlist no Spotify">Criar Playlist</button>
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

  // Clona o select para o import
  importContextSelect.innerHTML = addContextSelect.innerHTML;
  importContextSelect.value = addContextSelect.value;
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

  const createPlaylistBtn = e.target.closest('[data-create-playlist]');
  if (createPlaylistBtn) {
    const contextId = Number(createPlaylistBtn.dataset.createPlaylist);
    const originalText = createPlaylistBtn.textContent;
    createPlaylistBtn.disabled = true;
    createPlaylistBtn.textContent = 'Criando...';
    try {
      const res = await fetch('/api/spotify/playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextId }),
      });
      const data = await res.json();
      if (res.ok) {
        window.open(data.url, '_blank');
        createPlaylistBtn.textContent = 'Playlist Criada ✓';
      } else {
        alert(data.erro || 'Não foi possível criar a playlist.');
        createPlaylistBtn.disabled = false;
        createPlaylistBtn.textContent = originalText;
      }
    } catch {
      alert('Erro de rede ao tentar criar a playlist.');
      createPlaylistBtn.disabled = false;
      createPlaylistBtn.textContent = originalText;
    }
    return;
  }

  const playBtn = e.target.closest('[data-play-id]');
  if (playBtn && !playBtn.disabled) {
    const queueItemId = playBtn.dataset.playId;
    const originalText = playBtn.textContent;
    playBtn.disabled = true;
    playBtn.textContent = 'Tocando…';
    try {
      const res = await fetch('/api/spotify/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueItemId, deviceId: spotifyDeviceId }),
      });
      const data = await res.json();
      if (res.ok) {
        await fetch(`/api/queue/${queueItemId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'tocando' }),
        });
        spotifyPauseBtn.hidden = false;
        loadQueue();
      } else {
        alert(data.erro || 'Não foi possível tocar essa música.');
        playBtn.disabled = false;
        playBtn.textContent = originalText;
      }
    } catch {
      alert('Erro de conexão ao tentar tocar.');
      playBtn.disabled = false;
      playBtn.textContent = originalText;
    }
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

// --- Escolher Playlist do Spotify ---

function closePlaylistModal() {
  playlistModal.hidden = true;
}

playlistModalClose.addEventListener('click', closePlaylistModal);
playlistModal.querySelector('.pl-modal__backdrop').addEventListener('click', closePlaylistModal);

choosePlaylistBtn.addEventListener('click', async () => {
  const contextId = Number(importContextSelect.value);
  if (!contextId) return alert('Selecione um contexto primeiro.');

  choosePlaylistBtn.disabled = true;
  choosePlaylistBtn.textContent = 'Carregando...';
  choosePlaylistStatus.textContent = '';

  try {
    const res = await fetch('/api/spotify/my-playlists');
    const data = await res.json();

    if (!res.ok) {
      choosePlaylistStatus.textContent = data.erro || 'Erro ao buscar playlists.';
      return;
    }

    const playlists = data.playlists;
    if (!playlists.length) {
      choosePlaylistStatus.textContent = 'Nenhuma playlist encontrada na sua conta.';
      return;
    }

    // Popula o modal
    playlistModalList.innerHTML = playlists.map(pl => `
      <div class="pl-item">
        <img src="${pl.capa || ''}" alt="" onerror="this.style.visibility='hidden'" />
        <div class="pl-item__info">
          <div class="pl-item__name">${pl.nome}</div>
          <div class="pl-item__count">${pl.total} músicas</div>
        </div>
        <button class="pl-item__add"
          data-pl-id="${pl.id}"
          data-pl-nome="${encodeURIComponent(pl.nome)}"
          data-ctx-id="${contextId}">
          Importar
        </button>
      </div>
    `).join('');

    // Listener nos botões de importar dentro do modal
    playlistModalList.querySelectorAll('.pl-item__add').forEach(btn => {
      btn.addEventListener('click', async () => {
        const playlistId = btn.dataset.plId;
        const ctxId = Number(btn.dataset.ctxId);
        const nome = decodeURIComponent(btn.dataset.plNome);
        btn.disabled = true;
        btn.textContent = 'Importando...';

        try {
          const r = await fetch('/api/spotify/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contextId: ctxId, playlistId }),
          });
          const d = await r.json();
          if (r.ok) {
            btn.textContent = `✓ ${d.importedCount} adicionadas`;
            choosePlaylistStatus.textContent = `✅ ${d.importedCount} músicas de "${nome}" importadas!`;
            closePlaylistModal();
            loadQueue();
          } else {
            btn.disabled = false;
            btn.textContent = 'Importar';
            alert(d.erro || 'Falha ao importar.');
          }
        } catch {
          btn.disabled = false;
          btn.textContent = 'Importar';
          alert('Erro de conexão.');
        }
      });
    });

    playlistModal.hidden = false;

  } catch {
    choosePlaylistStatus.textContent = 'Erro de conexão.';
  } finally {
    choosePlaylistBtn.disabled = false;
    choosePlaylistBtn.textContent = '🎵 Ver Minhas Playlists';
  }
});


// --- Conexão e player de verdade do Spotify ---

let spotifySdkReady = false;
let spotifyConnected = false;

// IMPORTANTE: o SDK do Spotify chama esta função assim que termina de carregar.
// Ela precisa existir ANTES do SDK carregar, por isso é definida logo aqui no
// topo (não dentro de outra função). Quando o SDK avisar que está pronto,
// guardamos isso e tentamos iniciar o player se a conexão também já estiver ok.
window.onSpotifyWebPlaybackSDKReady = () => {
  spotifySdkReady = true;
  maybeStartPlayer();
};

function maybeStartPlayer() {
  if (!spotifySdkReady || !spotifyConnected || spotifyPlayer) return;

  spotifyPlayer = new Spotify.Player({
    name: 'Som da Academia',
    getOAuthToken: async (callback) => {
      const res = await fetch('/api/spotify/token');
      const data = await res.json();
      callback(data.accessToken);
    },
    volume: 0.8,
  });

  spotifyPlayer.addListener('ready', ({ device_id }) => {
    spotifyDeviceId = device_id;
    spotifyStatusEl.innerHTML = 'Spotify conectado — <strong>player pronto ✓</strong>';
    loadQueue(); // re-renderiza pra habilitar os botões "Tocar"
  });

  spotifyPlayer.addListener('not_ready', () => {
    spotifyDeviceId = null;
    spotifyStatusEl.textContent = 'Player do Spotify desconectado.';
  });

  spotifyPlayer.addListener('authentication_error', ({ message }) => {
    spotifyStatusEl.textContent = 'Erro de autenticação com o Spotify. Tente reconectar.';
    spotifyConnectBtn.hidden = false;
  });

  spotifyPlayer.addListener('account_error', () => {
    spotifyStatusEl.innerHTML = '<strong>Essa conta do Spotify não é Premium</strong> — o player de verdade exige Premium na conta conectada.';
  });

  spotifyPlayer.addListener('initialization_error', ({ message }) => {
    spotifyStatusEl.textContent = 'Não foi possível iniciar o player neste navegador: ' + message;
  });

  spotifyPlayer.connect();
}

async function checkSpotifyStatus() {
  try {
    const res = await fetch('/api/spotify/status');
    const data = await res.json();
    if (data.connected) {
      spotifyConnected = true;
      spotifyConnectBtn.hidden = true;
      spotifyDisconnectBtn.hidden = false;
      if (!spotifyPlayer) {
        spotifyStatusEl.innerHTML = 'Spotify conectado — <strong>carregando player…</strong>';
        maybeStartPlayer();
      }
    } else {
      spotifyStatusEl.textContent = 'Spotify ainda não conectado.';
      spotifyConnectBtn.hidden = false;
      spotifyDisconnectBtn.hidden = true;
    }
  } catch {
    spotifyStatusEl.textContent = 'Não foi possível verificar a conexão com o Spotify.';
  }
}

spotifyPauseBtn.addEventListener('click', async () => {
  await fetch('/api/spotify/pause', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: spotifyDeviceId }),
  });
});

checkSpotifyStatus();
setInterval(checkSpotifyStatus, 1000 * 20);