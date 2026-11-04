/**
 * Núcleo do Player Oficial.
 *
 * Modelo: só UMA tela (o "Player Oficial") cria o dispositivo do Spotify e faz o
 * som sair. Essa tela registra o device_id no servidor; a partir daí QUALQUER
 * tela controla o som chamando o servidor, que fala direto com a Web API do
 * Spotify apontando para o device oficial (play, pause, volume, pular).
 *
 * Fonte da verdade do "o que está tocando": queue_items.status = 'tocando'
 * (no máximo uma música no sistema inteiro). O Player Oficial só reporta
 * posição/pausa (para as outras telas mostrarem progresso) e avisa quando a
 * música acaba. Ele NUNCA decide sozinho o que tocar — isso é o que evita o
 * "volta ao começo" causado por várias telas disputando o play.
 */
const { query } = require('./db');
const { spotifyApi, resolveTrackUri } = require('./spotifyAuth');

const OFFLINE_APOS_MS = 45 * 1000; // sem sinal do player oficial há mais que isso = offline
const RETOMAR_SE_TOCAVA_HA_MS = 2 * 60 * 1000; // troca/recarga do oficial: continua a música se tocava há pouco
const IGNORAR_FIM_NOS_PRIMEIROS_MS = 8 * 1000; // um "acabou" logo após iniciar é estado velho do SDK
const MAX_PULOS_POR_AVANCO = 6; // músicas sem versão no Spotify que pulamos de uma vez

class PlayerError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const num = (v) => (v === null || v === undefined ? 0 : Number(v));

// ---------- Leitura de estado ----------

async function getState() {
  const { rows } = await query('SELECT * FROM player_state WHERE id = 1');
  if (rows[0]) return rows[0];
  await query('INSERT INTO player_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  const again = await query('SELECT * FROM player_state WHERE id = 1');
  return again.rows[0];
}

async function getCurrentItem() {
  const { rows } = await query(
    "SELECT * FROM queue_items WHERE status = 'tocando' ORDER BY atualizado_em DESC, id DESC LIMIT 1"
  );
  return rows[0] || null;
}

function isOnline(state, now = Date.now()) {
  return Boolean(state.owner_id && state.device_id && now - num(state.last_seen_em) < OFFLINE_APOS_MS);
}

/** Posição atual estimada: último reporte + tempo decorrido (se estiver tocando e online). */
function currentPositionMs(state, item, now = Date.now()) {
  const dur = num(state.duration_ms) || num(item && item.duracao_ms);
  const reported = num(state.reported_em);
  let pos = num(state.position_ms);
  if (!state.paused) {
    const ref = isOnline(state, now) ? now : Math.max(reported, num(state.last_seen_em));
    pos += Math.max(0, ref - reported);
  }
  if (dur > 0) pos = Math.min(pos, dur);
  return Math.max(0, Math.round(pos));
}

function itemView(r) {
  return {
    id: r.id,
    contextId: r.context_id,
    trackId: r.track_id,
    nome: r.nome,
    artista: r.artista,
    capaUrl: r.capa_url || null,
    duracaoMs: num(r.duracao_ms) || null,
    matricula: r.matricula || null,
    spotifyUri: r.spotify_uri || null,
  };
}

// ---------- Próxima música ----------

async function validPending(id, contextId) {
  const { rows } = await query(
    "SELECT * FROM queue_items WHERE id = $1 AND context_id = $2 AND status = 'pendente'",
    [id, contextId]
  );
  return rows[0] || null;
}

/**
 * Qual música toca depois. No modo aleatório a escolha é guardada em
 * player_state.next_item_id, para o "Próxima" mostrado no painel ser exatamente
 * a que vai tocar. No sequencial é a pendente mais antiga.
 */
async function pickNextItem(contextId, { exclude = [] } = {}) {
  const { rows: ctxRows } = await query('SELECT aleatorio FROM contexts WHERE id = $1', [contextId]);
  if (!ctxRows[0]) return null;

  if (!ctxRows[0].aleatorio) {
    const { rows } = await query(
      `SELECT * FROM queue_items WHERE context_id = $1 AND status = 'pendente'
       ORDER BY criado_em ASC, id ASC LIMIT $2`,
      [contextId, exclude.length + 1]
    );
    return rows.find((r) => !exclude.includes(r.id)) || null;
  }

  const state = await getState();
  if (state.next_item_id && !exclude.includes(state.next_item_id)) {
    const kept = await validPending(state.next_item_id, contextId);
    if (kept) return kept;
  }
  if (state.next_item_id) {
    await query('UPDATE player_state SET next_item_id = NULL WHERE id = 1 AND next_item_id = $1', [
      state.next_item_id,
    ]);
  }

  const { rows: ids } = await query(
    "SELECT id FROM queue_items WHERE context_id = $1 AND status = 'pendente'",
    [contextId]
  );
  const candidates = ids.map((r) => r.id).filter((id) => !exclude.includes(id));
  if (!candidates.length) return null;
  const chosenId = candidates[Math.floor(Math.random() * candidates.length)];

  // Guarda só se ninguém guardou antes (duas telas consultando ao mesmo tempo)
  await query('UPDATE player_state SET next_item_id = $1 WHERE id = 1 AND next_item_id IS NULL', [chosenId]);
  const after = await getState();
  if (after.next_item_id && !exclude.includes(after.next_item_id)) {
    const stored = await validPending(after.next_item_id, contextId);
    if (stored) return stored;
  }
  return validPending(chosenId, contextId);
}

// ---------- Visão pública do player (o que as telas pesquisam) ----------

async function getView() {
  const now = Date.now();
  const state = await getState();
  const current = await getCurrentItem();
  const next = current ? await pickNextItem(current.context_id) : null;
  const online = isOnline(state, now);

  return {
    serverNow: now,
    ownerId: state.owner_id || null,
    deviceReady: Boolean(state.device_id),
    online,
    paused: current ? Boolean(state.paused) || !online : true,
    positionMs: current ? currentPositionMs(state, current, now) : 0,
    durationMs: current ? num(state.duration_ms) || num(current.duracao_ms) : 0,
    volume: num(state.volume),
    nowPlaying: current ? itemView(current) : null,
    next: next ? itemView(next) : null,
  };
}

// ---------- Posse do Player Oficial ----------

async function claimOfficial(clientId) {
  const state = await getState();
  const now = Date.now();
  if (state.owner_id === clientId) {
    await query('UPDATE player_state SET last_seen_em = $1, atualizado_em = $1 WHERE id = 1', [now]);
    return;
  }
  // Novo dono: o device antigo deixa de valer (o novo registra o dele ao ficar pronto).
  // paused/posição ficam como estavam para a música poder continuar no novo player.
  await query(
    'UPDATE player_state SET owner_id = $1, device_id = NULL, next_item_id = NULL, atualizado_em = $2, last_seen_em = $2 WHERE id = 1',
    [clientId, now]
  );
}

async function releaseOfficial(clientId) {
  const state = await getState();
  if (state.owner_id !== clientId) return;
  const current = await getCurrentItem();
  const now = Date.now();
  const pos = current ? currentPositionMs(state, current, now) : 0;
  await query(
    `UPDATE player_state SET owner_id = NULL, device_id = NULL, paused = TRUE,
       position_ms = $1, reported_em = $2, atualizado_em = $2 WHERE id = 1`,
    [pos, now]
  );
}

async function isOfficial(clientId) {
  if (!clientId) return false;
  const state = await getState();
  return state.owner_id === clientId;
}

/**
 * A tela oficial avisa o device_id do player dela. Se a música estava tocando há
 * pouco (troca de tela oficial ou recarga da página), continua de onde parou.
 */
async function registerDevice(clientId, deviceId) {
  const before = await getState();
  if (before.owner_id !== clientId) throw new PlayerError(403, 'Esta tela não é o Player Oficial.', 'nao_oficial');
  const now = Date.now();
  const current = await getCurrentItem();

  if (before.device_id === deviceId) {
    await query('UPDATE player_state SET last_seen_em = $1 WHERE id = 1', [now]);
    return { ok: true, retomou: false };
  }

  const tocavaHaPouco =
    Boolean(current) && !before.paused && now - num(before.reported_em) < RETOMAR_SE_TOCAVA_HA_MS;
  const posicao = current ? currentPositionMs({ ...before, last_seen_em: now }, current, now) : 0;

  await query(
    'UPDATE player_state SET device_id = $1, last_seen_em = $2, paused = TRUE, position_ms = $3, reported_em = $2 WHERE id = 1',
    [deviceId, now, posicao]
  );

  if (tocavaHaPouco) {
    try {
      await startItem(current, { positionMs: Math.max(0, posicao - 500) });
      return { ok: true, retomou: true };
    } catch (err) {
      if (!(err instanceof PlayerError)) throw err;
      // não conseguiu retomar: fica pausado, a tela mostra o botão de continuar
    }
  }
  return { ok: true, retomou: false };
}

/** Sinal de vida + (opcional) posição/pausa reportadas pelo player oficial. */
async function report(clientId, { deviceId, positionMs, durationMs, paused } = {}) {
  const state = await getState();
  if (state.owner_id !== clientId) throw new PlayerError(403, 'Esta tela não é o Player Oficial.', 'nao_oficial');
  const now = Date.now();
  const hasPosition = Number.isFinite(positionMs) && typeof paused === 'boolean';

  if (!hasPosition) {
    await query('UPDATE player_state SET last_seen_em = $1, device_id = COALESCE($2, device_id) WHERE id = 1', [
      now,
      deviceId || null,
    ]);
    return;
  }
  await query(
    `UPDATE player_state SET last_seen_em = $1, device_id = COALESCE($2, device_id),
       paused = $3, position_ms = $4, duration_ms = $5, reported_em = $1 WHERE id = 1`,
    [now, deviceId || null, paused, Math.max(0, Math.round(positionMs)), Math.max(0, Math.round(durationMs || 0))]
  );
}

// ---------- Comandos ao Spotify ----------

function requireDevice(state) {
  if (!state.owner_id) {
    throw new PlayerError(409, 'Nenhuma tela é o Player Oficial. Ative "Player Oficial: ON" em uma tela para tocar.', 'sem_oficial');
  }
  if (!state.device_id) {
    throw new PlayerError(409, 'O Player Oficial ainda está carregando. Aguarde alguns segundos e tente de novo.', 'carregando');
  }
}

function spotifyFailure(res, acao) {
  if (res.status === 404) {
    return new PlayerError(409, 'O Player Oficial está offline (a tela foi fechada ou recarregada). Abra a tela oficial e aguarde o player ficar pronto.', 'offline');
  }
  if (res.status === 401) return new PlayerError(409, 'A conexão com o Spotify expirou. Reconecte o Spotify.', 'auth');
  if (res.status === 403) return new PlayerError(403, 'O Spotify recusou o comando (a conta conectada precisa ser Premium).', 'proibido');
  if (res.status === 429) {
    return new PlayerError(429, `O Spotify pediu um tempo${res.retryAfter ? ` (${res.retryAfter}s)` : ''}. Tente de novo em instantes.`, 'limite');
  }
  const detalhe = (res.data && res.data.error && res.data.error.message) || res.text || res.status;
  return new PlayerError(502, `O Spotify recusou o comando de ${acao}: ${detalhe}`, 'spotify');
}

async function spotifyCommand(method, path, args, acao) {
  let res = await spotifyApi(method, path, args);
  if (!res.ok && res.status >= 500) {
    // o Spotify às vezes devolve 5xx logo após uma troca de faixa; uma segunda tentativa resolve
    await new Promise((r) => setTimeout(r, 600));
    res = await spotifyApi(method, path, args);
  }
  if (!res.ok) throw spotifyFailure(res, acao);
  return res;
}

async function wrapNotConnected(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && err.status === 409 && !(err instanceof PlayerError)) {
      throw new PlayerError(409, err.message, 'sem_spotify');
    }
    throw err;
  }
}

async function resolveItemUri(item) {
  if (item.spotify_uri) return item.spotify_uri;
  let uri = null;
  // Itens antigos guardavam o ID do Spotify (22 caracteres); os atuais vêm do Deezer
  if (item.track_id && /^[a-zA-Z0-9]{22}$/.test(item.track_id)) uri = `spotify:track:${item.track_id}`;
  else uri = await resolveTrackUri(item.nome, item.artista);
  if (uri) await query('UPDATE queue_items SET spotify_uri = $1 WHERE id = $2', [uri, item.id]);
  return uri;
}

async function markPlaying(item, { positionMs = 0 } = {}) {
  const now = Date.now();
  // Só existe UMA música tocando no sistema inteiro
  await query("UPDATE queue_items SET status = 'tocada', atualizado_em = $1 WHERE status = 'tocando' AND id <> $2", [
    now,
    item.id,
  ]);
  await query("UPDATE queue_items SET status = 'tocando', atualizado_em = $1 WHERE id = $2", [now, item.id]);
  await query(
    'UPDATE player_state SET paused = FALSE, position_ms = $1, duration_ms = $2, reported_em = $3, next_item_id = NULL WHERE id = 1',
    [positionMs, num(item.duracao_ms), now]
  );
}

/** Manda o player oficial tocar esta música e só então atualiza o banco. */
async function startItem(item, { positionMs = 0 } = {}) {
  const state = await getState();
  requireDevice(state);

  let uri;
  try {
    uri = await resolveItemUri(item);
  } catch (err) {
    if (err && err.status === 429) {
      throw new PlayerError(429, 'O Spotify limitou as buscas por um momento. Tente de novo em instantes.', 'limite');
    }
    throw new PlayerError(502, `Falha ao procurar "${item.nome}" no Spotify: ${err.message}`, 'spotify');
  }
  if (!uri) {
    throw new PlayerError(404, `Não encontramos "${item.nome}" no catálogo do Spotify.`, 'sem_uri');
  }

  await wrapNotConnected(() =>
    spotifyCommand(
      'PUT',
      '/me/player/play',
      {
        query: { device_id: state.device_id },
        body: positionMs > 0 ? { uris: [uri], position_ms: Math.round(positionMs) } : { uris: [uri] },
      },
      'tocar'
    )
  );

  await markPlaying(item, { positionMs });
  return { uri };
}

async function pauseDevice(state) {
  if (!state.device_id) return false;
  try {
    const res = await spotifyApi('PUT', '/me/player/pause', { query: { device_id: state.device_id } });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------- Ações das telas ----------

async function playItem(itemId) {
  const { rows } = await query('SELECT * FROM queue_items WHERE id = $1', [itemId]);
  const item = rows[0];
  if (!item) throw new PlayerError(404, 'Item não encontrado.', 'nao_encontrado');
  if (item.status === 'removida') throw new PlayerError(409, 'Esta música foi removida da lista.', 'removida');
  await startItem(item);
  return itemView(item);
}

async function finishPlayback(current) {
  await query("UPDATE queue_items SET status = 'tocada', atualizado_em = $1 WHERE id = $2 AND status = 'tocando'", [
    Date.now(),
    current.id,
  ]);
  const state = await getState();
  await pauseDevice(state);
  await query(
    'UPDATE player_state SET paused = TRUE, position_ms = 0, duration_ms = 0, reported_em = $1, next_item_id = NULL WHERE id = 1',
    [Date.now()]
  );
}

/**
 * `current` acabou de sair de cena (terminou, foi pulada ou removida): toca a
 * próxima da mesma lista. Músicas sem versão no Spotify são puladas.
 * Sem próxima: encerra e pausa.
 */
async function playNextAfter(current, { revertTo = null } = {}) {
  const puladas = [];
  const exclude = [current.id];
  try {
    for (let i = 0; i < MAX_PULOS_POR_AVANCO; i++) {
      const next = await pickNextItem(current.context_id, { exclude });
      if (!next) break;
      try {
        await startItem(next);
        return { ok: true, tocando: itemView(next), puladas };
      } catch (err) {
        if (err instanceof PlayerError && err.code === 'sem_uri') {
          await query("UPDATE queue_items SET status = 'tocada', atualizado_em = $1 WHERE id = $2", [Date.now(), next.id]);
          puladas.push(next.nome);
          exclude.push(next.id);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    // Falhou por motivo externo (offline, limite, auth): desfaz a saída de cena, se pedido,
    // para o painel não mostrar "nada tocando" enquanto o som ainda está tocando.
    if (revertTo) {
      await query(
        "UPDATE queue_items SET status = 'tocando', atualizado_em = $1 WHERE id = $2 AND status = 'tocada' AND atualizado_em = $3",
        [revertTo.originalAt, current.id, revertTo.claimedAt]
      );
    }
    throw err;
  }
  await finishPlayback(current);
  return { ok: true, fim: true, puladas };
}

/** Tira a música atual de cena de forma atômica; devolve null se outra ação chegou antes. */
async function claimCurrent(current) {
  const claimedAt = Date.now();
  const res = await query(
    "UPDATE queue_items SET status = 'tocada', atualizado_em = $1 WHERE id = $2 AND status = 'tocando'",
    [claimedAt, current.id]
  );
  return res.rowCount === 1 ? { claimedAt, originalAt: num(current.atualizado_em) } : null;
}

/** Botão "Pular" (qualquer tela). */
async function skip() {
  const current = await getCurrentItem();
  if (!current) throw new PlayerError(409, 'Não há música tocando agora.', 'nada_tocando');
  const claim = await claimCurrent(current);
  if (!claim) return { ok: true, ignorado: true };
  return playNextAfter(current, { revertTo: claim });
}

/**
 * O Player Oficial avisa que a música acabou ou está nos segundos finais (`early`).
 * Avanço antecipado sem próxima música NÃO encerra: a última música toca até o fim.
 */
async function trackEnded(itemId, { early = false } = {}) {
  const current = await getCurrentItem();
  if (!current || current.id !== Number(itemId)) return { ok: true, ignorado: true };
  if (Date.now() - num(current.atualizado_em) < IGNORAR_FIM_NOS_PRIMEIROS_MS) return { ok: true, ignorado: true };
  if (early) {
    const next = await pickNextItem(current.context_id);
    if (!next) return { ok: true, ignorado: true, semProxima: true };
  }
  const claim = await claimCurrent(current);
  if (!claim) return { ok: true, ignorado: true };
  return playNextAfter(current, { revertTo: claim });
}

/**
 * Chamado depois que o status da música que estava tocando mudou por fora
 * (removida, marcada como tocada, devolvida à fila): avança o som.
 */
async function currentLeft(item) {
  return playNextAfter(item);
}

async function pause() {
  const state = await getState();
  requireDevice(state);
  const current = await getCurrentItem();
  const pos = current ? currentPositionMs(state, current) : 0;
  await wrapNotConnected(() =>
    spotifyCommand('PUT', '/me/player/pause', { query: { device_id: state.device_id } }, 'pausar')
  );
  await query('UPDATE player_state SET paused = TRUE, position_ms = $1, reported_em = $2 WHERE id = 1', [pos, Date.now()]);
}

async function resume() {
  const state = await getState();
  requireDevice(state);
  const current = await getCurrentItem();
  if (!current) throw new PlayerError(409, 'Não há música para continuar.', 'nada_tocando');
  const pos = currentPositionMs(state, current);

  try {
    await wrapNotConnected(() =>
      spotifyCommand('PUT', '/me/player/play', { query: { device_id: state.device_id } }, 'continuar')
    );
    await query('UPDATE player_state SET paused = FALSE, position_ms = $1, reported_em = $2 WHERE id = 1', [pos, Date.now()]);
  } catch (err) {
    // O device pode ter perdido a faixa carregada (ex.: tela recarregada): recomeça de onde parou
    if (err instanceof PlayerError && ['spotify', 'offline', 'proibido'].includes(err.code)) {
      await startItem(current, { positionMs: pos });
    } else {
      throw err;
    }
  }
}

async function setVolume(volumePercent) {
  const v = Math.round(Number(volumePercent));
  if (!Number.isFinite(v) || v < 0 || v > 100) {
    throw new PlayerError(400, 'volume_percent deve ser entre 0 e 100.', 'invalido');
  }
  await query('UPDATE player_state SET volume = $1 WHERE id = 1', [v]);
  const state = await getState();
  let aplicado = false;
  if (state.device_id) {
    try {
      const res = await spotifyApi('PUT', '/me/player/volume', {
        query: { volume_percent: v, device_id: state.device_id },
      });
      aplicado = res.ok;
    } catch {
      aplicado = false;
    }
  }
  // Mesmo se o Spotify não aplicou agora, a tela oficial lê o volume combinado e aplica sozinha.
  return { ok: true, volume: v, aplicado };
}

/** Lista excluída/esvaziada: se a música tocando era dela, para o som. */
async function stopIfPlayingInContext(contextId) {
  const current = await getCurrentItem();
  if (!current || current.context_id !== Number(contextId)) return false;
  const state = await getState();
  await pauseDevice(state);
  await query(
    'UPDATE player_state SET paused = TRUE, position_ms = 0, duration_ms = 0, reported_em = $1, next_item_id = NULL WHERE id = 1',
    [Date.now()]
  );
  return true;
}

module.exports = {
  PlayerError,
  getState,
  getCurrentItem,
  getView,
  claimOfficial,
  releaseOfficial,
  isOfficial,
  registerDevice,
  report,
  playItem,
  skip,
  trackEnded,
  currentLeft,
  pause,
  resume,
  setVolume,
  stopIfPlayingInContext,
  // expostos para testes
  _internals: { pickNextItem, currentPositionMs, isOnline },
};
