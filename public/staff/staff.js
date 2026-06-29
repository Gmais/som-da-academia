const strips = document.getElementById('strips');
const activeBanner = document.getElementById('active-context-name');
const clockEl = document.getElementById('clock');
const contextEditor = document.getElementById('context-editor');
const qrImg = document.getElementById('qr-img');
const addContextSelect = document.getElementById('add-context-select');
const addSearchInput = document.getElementById('add-search-input');
const addResultsEl = document.getElementById('add-results');
const importContextSelect = document.getElementById('import-context-select');
const importTextArea = document.getElementById('import-text-area');
const importTextBtn = document.getElementById('import-text-btn');
const importTextStatus = document.getElementById('import-text-status');
const spotifyStatusEl = document.getElementById('spotify-status');
const spotifyConnectBtn = document.getElementById('spotify-connect-btn');
const spotifyDisconnectBtn = document.getElementById('spotify-disconnect-btn');
const spotifyPauseBtn = document.getElementById('spotify-pause-btn');

let spotifyDeviceId = null;
let spotifyPlayer = null;

let knownContexts = [];
let addDebounceTimer = null;
let addLastQuery = '';
let randomModes = JSON.parse(localStorage.getItem('sda_random_modes') || '{}');

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
      <div class="track-progress">
        <div class="track-progress__fill" id="progress-${item.id}"></div>
      </div>
      <div class="track-row__duration">${fmtDuration(item.duracao_ms)}</div>
      <div class="track-row__actions">
        <button class="btn btn--primary" data-play-id="${item.id}" ${spotifyDeviceId ? '' : 'disabled title="Conecte o Spotify e espere o player ficar pronto"'}>${isPlaying ? 'Tocando' : '▶ Tocar'}</button>
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
            <span class="strip__name">${escapeHtml(ctx.nome)}</span>
            <span class="strip__meta">
              <span class="level">${levelDots(ctx.naFila)}</span>
              <span class="strip__count">${ctx.naFila} na fila</span>
              <label class="toggle-random" title="Tocar músicas deste contexto de forma aleatória">
                <input type="checkbox" data-random-context="${ctx.id}" class="random-checkbox" ${randomModes[ctx.id] ? 'checked' : ''} />
                <span class="random-label">Tocar Aleatório</span>
              </label>
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
      <div class="ctx-edit-row" data-ctx-id="${ctx.id}" style="display:flex; gap:4px; align-items:center;">
        <input type="text" value="${escapeHtml(ctx.nome)}" data-field="nome" style="flex:1" />
        <button class="btn btn--danger" data-delete-context="${ctx.id}" title="Excluir contexto" style="padding: 4px 8px; margin: 0;">✕</button>
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

  const shuffleBtn = e.target.closest('[data-shuffle-context]');
  if (shuffleBtn) {
    const contextId = Number(shuffleBtn.dataset.shuffleContext);
    const originalText = shuffleBtn.textContent;
    shuffleBtn.disabled = true;
    shuffleBtn.textContent = 'Embaralhando...';
    try {
      const r = await fetch(`/api/contexts/${contextId}/shuffle`, { method: 'POST' });
      if (r.ok) {
        shuffleBtn.textContent = '✓ Pronto';
        loadQueue();
        setTimeout(() => {
          shuffleBtn.textContent = originalText;
          shuffleBtn.disabled = false;
        }, 2000);
      } else {
        shuffleBtn.disabled = false;
        shuffleBtn.textContent = originalText;
        alert('Falha ao embaralhar.');
      }
    } catch {
      shuffleBtn.disabled = false;
      shuffleBtn.textContent = originalText;
      alert('Erro de conexão ao tentar embaralhar.');
    }
    return;
  }

  const playBtn = e.target.closest('[data-play-id]');
  if (playBtn && !playBtn.disabled) {
    const row = playBtn.closest('.track-row');
    if (row && row.dataset.status === 'tocando') {
      if (spotifyPlayer) {
        spotifyPlayer.togglePlay();
      }
      return;
    }

    const queueItemId = playBtn.dataset.playId;
    const originalText = playBtn.textContent;
    playBtn.disabled = true;
    playBtn.textContent = 'Carregando…';
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

strips.addEventListener('change', (e) => {
  if (e.target.classList.contains('random-checkbox')) {
    const contextId = e.target.dataset.randomContext;
    randomModes[contextId] = e.target.checked;
    localStorage.setItem('sda_random_modes', JSON.stringify(randomModes));
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

contextEditor.addEventListener('click', async (e) => {
  const deleteBtn = e.target.closest('[data-delete-context]');
  if (deleteBtn) {
    const id = deleteBtn.dataset.deleteContext;
    if (!confirm('Tem certeza que quer excluir este contexto? Todas as músicas na fila dele serão perdidas.')) return;
    deleteBtn.disabled = true;
    try {
      const res = await fetch(`/api/contexts/${id}`, { method: 'DELETE' });
      if (res.ok) {
        if (viewingContextId === Number(id)) viewingContextId = null;
        loadQueue();
      } else {
        alert('Falha ao excluir.');
        deleteBtn.disabled = false;
      }
    } catch {
      alert('Erro ao excluir contexto.');
      deleteBtn.disabled = false;
    }
  }
});

document.getElementById('add-context-btn')?.addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = 'Adicionando...';
  try {
    const res = await fetch('/api/contexts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nome: 'Nova Categoria',
        cor: '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0') // cor aleatoria
      }),
    });
    if (res.ok) {
      loadQueue();
    } else {
      alert('Falha ao criar contexto.');
    }
  } catch {
    alert('Erro de conexão.');
  } finally {
    btn.disabled = false;
    btn.textContent = '+ Novo Contexto';
  }
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

// --- Importação em Massa (Texto) ---

importTextBtn.addEventListener('click', async () => {
  const contextId = Number(importContextSelect.value);
  const text = importTextArea.value.trim();
  
  if (!contextId) return alert('Selecione um contexto primeiro.');
  if (!text) return alert('Cole uma lista de músicas primeiro.');

  // Extrai cada linha ignorando vazias
  const queries = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (queries.length === 0) return;

  if (queries.length > 200) {
    return alert('Por favor, limite a 200 músicas por vez para não sobrecarregar o Spotify.');
  }

  importTextBtn.disabled = true;
  importTextBtn.textContent = 'Buscando e Importando...';
  importTextStatus.textContent = 'Isso pode levar alguns segundos...';

  try {
    const res = await fetch('/api/spotify/mass-import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextId, queries }),
    });
    const data = await res.json();

    if (res.ok) {
      importTextStatus.textContent = `✅ ${data.importedCount} de ${queries.length} músicas encontradas e adicionadas!`;
      importTextArea.value = '';
      loadQueue();
    } else {
      importTextStatus.textContent = '';
      alert(data.erro || 'Falha ao importar lista.');
    }
  } catch {
    importTextStatus.textContent = '';
    alert('Erro de conexão.');
  } finally {
    importTextBtn.disabled = false;
    importTextBtn.textContent = 'Importar Lista';
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

  let currentTrackId = null;
  spotifyPlayer.addListener('player_state_changed', async (state) => {
    if (!state) return;
    
    // Detecta se a música acabou (paused = true, position = 0 e tem tracks anteriores)
    if (state.paused && state.position === 0 && state.track_window.previous_tracks.length > 0) {
      const endedTrackId = state.track_window.previous_tracks[0].id;
      
      // Para não rodar duas vezes pro mesmo track_id
      if (currentTrackId !== endedTrackId) {
        currentTrackId = endedTrackId;
        
        // Descobre qual contexto tem a música "tocando" no momento
        const { contexts, activeContext } = knownContexts ? { contexts: knownContexts, activeContext: null } : { contexts: [], activeContext: null };
        let activeCtxId = null;
        for (const ctx of contexts) {
          // A gente descobre o contexto ativo procurando no HTML onde está a classe tocando
          const tocandoRow = document.querySelector(`.strip[data-context-id="${ctx.id}"] .track-row[data-status="tocando"]`);
          if (tocandoRow) {
            activeCtxId = ctx.id;
            break;
          }
        }
        
        if (activeCtxId) {
          // Verifica se o checkbox de Tocar Aleatório deste contexto está marcado
          const checkbox = document.querySelector(`input[data-random-context="${activeCtxId}"]`);
          const isRandom = checkbox ? checkbox.checked : false;
          
          try {
            await fetch('/api/spotify/play-next', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceId: spotifyDeviceId, contextId: activeCtxId, random: isRandom })
            });
            loadQueue();
          } catch (e) {
            console.error('Erro no Auto-DJ:', e);
          }
        }
      }
    } else if (!state.paused) {
      currentTrackId = null; // reseta ao tocar normalmente
    }
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

// Loop para atualizar a barra de progresso da música tocando
setInterval(async () => {
  if (!spotifyPlayer) return;
  const tocandoRow = document.querySelector('.track-row[data-status="tocando"]');
  if (!tocandoRow) return;
  const queueItemId = tocandoRow.dataset.id;
  const fillEl = document.getElementById(`progress-${queueItemId}`);
  if (!fillEl) return;
  
  const state = await spotifyPlayer.getCurrentState();
  if (state && state.duration > 0) {
    if (!state.paused) {
      const pct = (state.position / state.duration) * 100;
      fillEl.style.width = `${pct}%`;
    }
    
    // Atualizar texto do botão
    const playBtn = tocandoRow.querySelector('[data-play-id]');
    if (playBtn) {
      playBtn.textContent = state.paused ? 'Pausado' : 'Tocando';
    }
  }
}, 1000);