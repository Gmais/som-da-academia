const express = require('express');
const { nanoid } = require('nanoid');
const { query } = require('../db');
const {
  getAuthorizeUrl,
  exchangeCodeForToken,
  getValidAccessToken,
  isConnected,
  resolveTrackUri,
} = require('../spotifyAuth');

const router = express.Router();

// GET /api/spotify/status -> a academia já conectou a conta Premium?
router.get('/status', async (req, res, next) => {
  try {
    res.json({ connected: await isConnected() });
  } catch (err) {
    next(err);
  }
});

// --- Player Oficial: só uma tela (clientId) pode tocar; as outras só controlam ---

async function getOfficialOwner() {
  const { rows } = await query('SELECT owner_id FROM player_state WHERE id = 1');
  return rows[0]?.owner_id || null;
}

// GET /api/spotify/official -> qual tela é o Player Oficial agora
router.get('/official', async (req, res, next) => {
  try {
    res.json({ ownerId: await getOfficialOwner() });
  } catch (err) {
    next(err);
  }
});

// PUT /api/spotify/official -> esta tela vira o Player Oficial (as outras perdem o posto)
router.put('/official', async (req, res, next) => {
  try {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ erro: 'clientId é obrigatório.' });
    await query(
      `INSERT INTO player_state (id, owner_id, atualizado_em) VALUES (1, $1, $2)
       ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id, atualizado_em = EXCLUDED.atualizado_em`,
      [clientId, Date.now()]
    );
    res.json({ ownerId: clientId });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/spotify/official -> esta tela deixa de ser o Player Oficial (só se ainda for a dona)
router.delete('/official', async (req, res, next) => {
  try {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ erro: 'clientId é obrigatório.' });
    await query(
      'UPDATE player_state SET owner_id = NULL, atualizado_em = $1 WHERE id = 1 AND owner_id = $2',
      [Date.now(), clientId]
    );
    res.json({ ownerId: await getOfficialOwner() });
  } catch (err) {
    next(err);
  }
});

// Barreira no servidor: só o Player Oficial pode mandar tocar
async function requireOfficial(req, res, next) {
  try {
    const { clientId } = req.body;
    if (!clientId || clientId !== (await getOfficialOwner())) {
      return res.status(403).json({ erro: 'Esta tela não é o Player Oficial. Ative "Player Oficial" aqui para tocar.' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// GET /api/spotify/login -> inicia o fluxo OAuth, redireciona pro Spotify
router.get('/login', (req, res) => {
  const state = nanoid();
  res.redirect(getAuthorizeUrl(state));
});

// GET /api/spotify/logout -> remove a conta conectada
router.get('/logout', async (req, res, next) => {
  try {
    await query('DELETE FROM spotify_auth WHERE id = 1');
    res.redirect('/staff');
  } catch (err) {
    next(err);
  }
});

// GET /api/spotify/callback -> o Spotify volta pra cá depois do login
router.get('/callback', async (req, res, next) => {
  try {
    const { code, error } = req.query;
    if (error) {
      return res.redirect(`/staff?spotify_erro=${encodeURIComponent(error)}`);
    }
    await exchangeCodeForToken(code);
    res.redirect('/staff?spotify_conectado=1');
  } catch (err) {
    next(err);
  }
});

// GET /api/spotify/token -> token de acesso pro Web Playback SDK (front-end)
router.get('/token', async (req, res, next) => {
  try {
    const token = await getValidAccessToken();
    if (!token) return res.status(409).json({ erro: 'Spotify não conectado ainda.' });
    res.json({ accessToken: token });
  } catch (err) {
    next(err);
  }
});

// POST /api/spotify/play -> resolve o URI exato e manda tocar no dispositivo
router.post('/play', requireOfficial, async (req, res, next) => {
  try {
    const { queueItemId, deviceId } = req.body;
    if (!queueItemId || !deviceId) {
      return res.status(400).json({ erro: 'queueItemId e deviceId são obrigatórios.' });
    }

    const { rows } = await query('SELECT * FROM queue_items WHERE id = $1', [queueItemId]);
    const item = rows[0];
    if (!item) return res.status(404).json({ erro: 'Item não encontrado.' });

    let uri;
    // Se o track_id for um ID válido do Spotify (22 caracteres alfanuméricos), usamos direto.
    // Isso evita o rate limit (429) na rota de busca.
    if (item.track_id && item.track_id.length === 22 && /^[a-zA-Z0-9]+$/.test(item.track_id)) {
      uri = `spotify:track:${item.track_id}`;
    } else {
      uri = await resolveTrackUri(item.nome, item.artista);
    }
    
    if (!uri) {
      return res.status(404).json({ erro: 'Não encontramos essa música no catálogo do Spotify.' });
    }

    const token = await getValidAccessToken();
    if (!token) return res.status(409).json({ erro: 'Spotify não conectado ainda.' });

    const playRes = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uris: [uri] }),
    });

    if (!playRes.ok && playRes.status !== 204) {
      const text = await playRes.text();
      return res.status(502).json({ erro: `Spotify recusou o comando de tocar: ${text}` });
    }

    res.json({ ok: true, uri });
  } catch (err) {
    next(err);
  }
});

// POST /api/spotify/play-next -> Toca a próxima música (aleatória ou sequencial)
router.post('/play-next', requireOfficial, async (req, res, next) => {
  try {
    const { contextId, deviceId, random } = req.body;
    if (!contextId || !deviceId) {
      return res.status(400).json({ erro: 'Faltam dados obrigatórios.' });
    }

    // Primeiro, marca as músicas "tocando" desse contexto como "tocada"
    await query("UPDATE queue_items SET status = 'tocada', atualizado_em = $1 WHERE context_id = $2 AND status = 'tocando'", [Date.now(), contextId]);

    // Busca as pendentes
    const orderBy = random ? 'RANDOM()' : 'criado_em ASC';
    const { rows } = await query(`SELECT * FROM queue_items WHERE context_id = $1 AND status = 'pendente' ORDER BY ${orderBy} LIMIT 1`, [contextId]);
    
    if (rows.length === 0) {
      return res.json({ message: 'Fila vazia.' });
    }
    const nextItem = rows[0];

    // Toca
    let uri;
    if (nextItem.track_id && nextItem.track_id.length === 22 && /^[a-zA-Z0-9]+$/.test(nextItem.track_id)) {
      uri = `spotify:track:${nextItem.track_id}`;
    } else {
      uri = await resolveTrackUri(nextItem.nome, nextItem.artista);
    }
    
    if (!uri) return res.status(404).json({ erro: 'Não achou URI' });

    const token = await getValidAccessToken();
    const playRes = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uris: [uri] }),
    });

    if (playRes.ok || playRes.status === 204) {
      await query("UPDATE queue_items SET status = 'tocando', atualizado_em = $1 WHERE id = $2", [Date.now(), nextItem.id]);
      return res.json({ ok: true });
    } else {
      return res.status(502).json({ erro: 'Erro do Spotify' });
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/spotify/pause -> pausa o playback
router.post('/pause', async (req, res, next) => {
  try {
    const { deviceId } = req.body;
    const token = await getValidAccessToken();
    if (!token) return res.status(409).json({ erro: 'Spotify não conectado ainda.' });

    const url = deviceId
      ? `https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}`
      : 'https://api.spotify.com/v1/me/player/pause';

    const pauseRes = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!pauseRes.ok && pauseRes.status !== 204) {
      const text = await pauseRes.text();
      return res.status(502).json({ erro: `Spotify recusou o comando de pausar: ${text}` });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/spotify/playlist -> cria uma playlist no Spotify com a fila de um contexto
router.post('/playlist', async (req, res, next) => {
  try {
    const { contextId } = req.body;
    if (!contextId) return res.status(400).json({ erro: 'contextId é obrigatório.' });

    const token = await getValidAccessToken();
    if (!token) return res.status(409).json({ erro: 'Spotify não conectado ainda.' });

    // 1. Obter perfil do usuário (para pegar o ID)
    const meRes = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meRes.ok) return res.status(502).json({ erro: 'Falha ao obter perfil do Spotify.' });
    const meData = await meRes.json();
    const userId = meData.id;

    // 2. Obter nome do contexto
    const { rows: ctxRows } = await query('SELECT nome FROM contexts WHERE id = $1', [contextId]);
    if (!ctxRows[0]) return res.status(404).json({ erro: 'Contexto não encontrado.' });
    const ctxName = ctxRows[0].nome;

    // 3. Obter as músicas da fila (pendente, tocando, tocada)
    const { rows: tracks } = await query(
      `SELECT track_id FROM queue_items
       WHERE context_id = $1 AND status IN ('pendente', 'tocando', 'tocada')
       ORDER BY (status = 'tocando') DESC, criado_em ASC`,
      [contextId]
    );

    if (tracks.length === 0) {
      return res.status(400).json({ erro: 'Não há músicas na fila desse contexto para criar uma playlist.' });
    }

    const uris = tracks.map((t) => `spotify:track:${t.track_id}`);

    // 4. Criar a playlist
    const createRes = await fetch(`https://api.spotify.com/v1/users/${userId}/playlists`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Academia: ${ctxName}`,
        description: `Playlist gerada automaticamente pelo Som da Academia em ${new Date().toLocaleDateString('pt-BR')}`,
        public: true,
      }),
    });

    if (!createRes.ok) {
      const text = await createRes.text();
      return res.status(502).json({ erro: `Falha ao criar playlist: ${text}` });
    }
    const playlistData = await createRes.json();
    const playlistId = playlistData.id;

    // 5. Adicionar músicas à playlist (lotes de 100)
    for (let i = 0; i < uris.length; i += 100) {
      const chunk = uris.slice(i, i + 100);
      await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ uris: chunk }),
      });
    }

    res.json({ ok: true, url: playlistData.external_urls.spotify });
  } catch (err) {
    next(err);
  }
});

// GET /api/spotify/my-playlists -> lista as playlists do usuário conectado
router.get('/my-playlists', async (req, res, next) => {
  try {
    const token = await getValidAccessToken();
    if (!token) return res.status(409).json({ erro: 'Spotify não conectado. Conecte sua conta primeiro.' });

    let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
    let playlists = [];

    while (url) {
      const pRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!pRes.ok) {
        const text = await pRes.text();
        return res.status(502).json({ erro: `Falha ao buscar playlists: ${text}` });
      }
      const data = await pRes.json();
      playlists.push(...data.items.filter(Boolean).map(pl => ({
        id: pl.id,
        nome: pl.name,
        total: pl.tracks?.total || 0,
        capa: pl.images?.[0]?.url || null,
      })));
      url = data.next;
    }

    res.json({ ok: true, playlists });
  } catch (err) {
    next(err);
  }
});

// POST /api/spotify/mass-import-text -> pesquisa várias músicas por texto e adiciona
router.post('/mass-import-text', async (req, res, next) => {
  try {
    const { contextId, queries } = req.body;
    if (!contextId || !Array.isArray(queries) || queries.length === 0) {
      return res.status(400).json({ erro: 'contextId e array de queries são obrigatórios.' });
    }

    const { searchTracks } = require('../catalog');

    let importedCount = 0;
    const agora = Date.now();

    for (const q of queries) {
      if (!q) continue;

      try {
        const resultados = await searchTracks(q, 1);
        if (resultados && resultados.length > 0) {
          const track = resultados[0];
          
          await query(
            `INSERT INTO queue_items
              (context_id, track_id, nome, artista, capa_url, duracao_ms, status, criado_em, atualizado_em)
             VALUES ($1, $2, $3, $4, $5, $6, 'pendente', $7, $7)`,
            [contextId, track.trackId, track.nome, track.artista, track.capaUrl, track.duracaoMs, agora]
          );
          importedCount++;
        }
      } catch (err) {
        // ignora erros individuais pra não parar a importação inteira
      }
    }

    res.json({ ok: true, importedCount });
  } catch (err) {
    next(err);
  }
});

// PUT /api/spotify/volume -> ajusta o volume no dispositivo ativo do Spotify
router.put('/volume', async (req, res, next) => {
  try {
    const { volume_percent } = req.body;
    if (volume_percent == null || volume_percent < 0 || volume_percent > 100) {
      return res.status(400).json({ erro: 'volume_percent deve ser entre 0 e 100.' });
    }

    const token = await getValidAccessToken();
    if (!token) return res.status(409).json({ erro: 'Spotify não conectado ainda.' });

    const volRes = await fetch(
      `https://api.spotify.com/v1/me/player/volume?volume_percent=${Math.round(volume_percent)}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!volRes.ok && volRes.status !== 204) {
      const text = await volRes.text();
      return res.status(502).json({ erro: `Spotify recusou o comando de volume: ${text}` });
    }

    res.json({ ok: true, volume_percent: Math.round(volume_percent) });
  } catch (err) {
    next(err);
  }
});

// GET /api/spotify/volume -> lê o volume atual do dispositivo ativo
router.get('/volume', async (req, res, next) => {
  try {
    const token = await getValidAccessToken();
    if (!token) return res.status(409).json({ erro: 'Spotify não conectado ainda.' });

    const stateRes = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { Authorization: `Bearer ${token}` },
    });

    // 204 = nenhum dispositivo ativo
    if (stateRes.status === 204) {
      return res.json({ volume_percent: null, device: null });
    }

    if (!stateRes.ok) {
      const text = await stateRes.text();
      return res.status(502).json({ erro: `Falha ao ler estado do player: ${text}` });
    }

    const data = await stateRes.json();
    res.json({
      volume_percent: data.device?.volume_percent ?? null,
      device: data.device?.name ?? null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
