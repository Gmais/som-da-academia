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
router.post('/play', async (req, res, next) => {
  try {
    const { queueItemId, deviceId } = req.body;
    if (!queueItemId || !deviceId) {
      return res.status(400).json({ erro: 'queueItemId e deviceId são obrigatórios.' });
    }

    const { rows } = await query('SELECT * FROM queue_items WHERE id = $1', [queueItemId]);
    const item = rows[0];
    if (!item) return res.status(404).json({ erro: 'Item não encontrado.' });

    const uri = await resolveTrackUri(item.nome, item.artista);
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

    const { getAppAccessToken } = require('../spotifyAuth');
    let token = await getValidAccessToken();
    // Fallback pra app token se o usuário não estiver logado ou algo assim, 
    // já que o endpoint de busca funciona bem com app token
    if (!token) token = await getAppAccessToken();

    let importedCount = 0;
    const agora = Date.now();

    for (const q of queries) {
      if (!q) continue;

      const url = new URL('https://api.spotify.com/v1/search');
      url.searchParams.set('q', q);
      url.searchParams.set('type', 'track');
      url.searchParams.set('limit', '1');

      const sRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!sRes.ok) continue; // ignora erros individuais pra não parar a importação inteira

      const data = await sRes.json();
      const track = data.tracks?.items?.[0];
      
      if (track && !track.is_local) {
        const nome = track.name;
        const artista = track.artists?.map(a => a.name).join(', ') || 'Desconhecido';
        const capaUrl = track.album?.images?.[0]?.url || null;
        const duracaoMs = track.duration_ms || null;

        await query(
          `INSERT INTO queue_items
            (context_id, track_id, nome, artista, capa_url, duracao_ms, status, criado_em, atualizado_em)
           VALUES ($1, $2, $3, $4, $5, $6, 'pendente', $7, $7)`,
          [contextId, track.id, nome, artista, capaUrl, duracaoMs, agora]
        );
        importedCount++;
      }
    }

    res.json({ ok: true, importedCount });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
