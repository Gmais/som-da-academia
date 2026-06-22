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

module.exports = router;
