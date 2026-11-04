const express = require('express');
const { nanoid } = require('nanoid');
const { query } = require('../db');
const {
  getAuthorizeUrl,
  exchangeCodeForToken,
  getValidAccessToken,
  isConnected,
  resolveTrackUri,
  spotifyApi,
} = require('../spotifyAuth');
const { searchTracks } = require('../catalog');
const { mapLimit } = require('../util');

const router = express.Router();

const OAUTH_STATE_COOKIE = 'sda_oauth_state';
const MAX_IMPORT = 200;

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
  // O mesmo valor volta na URL do callback; comparar com o cookie impede que alguém
  // conecte outra conta Spotify ao painel usando um link forjado.
  res.cookie(OAUTH_STATE_COOKIE, state, { maxAge: 10 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
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
    const { code, error, state } = req.query;
    if (error) {
      return res.redirect(`/staff?spotify_erro=${encodeURIComponent(error)}`);
    }
    const expected = req.cookies && req.cookies[OAUTH_STATE_COOKIE];
    res.clearCookie(OAUTH_STATE_COOKIE);
    if (!code || !state || !expected || state !== expected) {
      return res.redirect('/staff?spotify_erro=' + encodeURIComponent('login_invalido'));
    }
    await exchangeCodeForToken(code);
    res.redirect('/staff?spotify_conectado=1');
  } catch (err) {
    next(err);
  }
});

// GET /api/spotify/token -> token de acesso pro Web Playback SDK (só o Player Oficial usa)
router.get('/token', async (req, res, next) => {
  try {
    const token = await getValidAccessToken();
    if (!token) return res.status(409).json({ erro: 'Spotify não conectado ainda.' });
    res.json({ accessToken: token });
  } catch (err) {
    next(err);
  }
});

// POST /api/spotify/playlist -> cria uma playlist no Spotify com a fila de um contexto
router.post('/playlist', async (req, res, next) => {
  try {
    const contextId = Number(req.body.contextId);
    if (!Number.isInteger(contextId) || contextId <= 0) {
      return res.status(400).json({ erro: 'contextId é obrigatório.' });
    }

    if (!(await isConnected())) return res.status(409).json({ erro: 'Spotify não conectado ainda.' });

    const { rows: ctxRows } = await query('SELECT nome FROM contexts WHERE id = $1', [contextId]);
    if (!ctxRows[0]) return res.status(404).json({ erro: 'Contexto não encontrado.' });
    const ctxName = ctxRows[0].nome;

    // Músicas da lista (pendente, tocando, tocada)
    const { rows: tracks } = await query(
      `SELECT id, track_id, nome, artista, spotify_uri FROM queue_items
       WHERE context_id = $1 AND status IN ('pendente', 'tocando', 'tocada')
       ORDER BY (status = 'tocando') DESC, criado_em ASC, id ASC`,
      [contextId]
    );
    if (tracks.length === 0) {
      return res.status(400).json({ erro: 'Não há músicas na fila desse contexto para criar uma playlist.' });
    }

    // O banco guarda IDs do Deezer; o Spotify precisa da URI dele. Resolve (e guarda) as que faltam.
    const resolved = await mapLimit(tracks, 4, async (t) => {
      if (t.spotify_uri) return t.spotify_uri;
      let uri = null;
      if (t.track_id && /^[a-zA-Z0-9]{22}$/.test(t.track_id)) uri = `spotify:track:${t.track_id}`;
      else uri = await resolveTrackUri(t.nome, t.artista);
      if (uri) await query('UPDATE queue_items SET spotify_uri = $1 WHERE id = $2', [uri, t.id]);
      return uri;
    });

    const uris = [];
    const naoEncontradas = [];
    resolved.forEach((r, i) => {
      if (r.ok && r.valor) {
        if (!uris.includes(r.valor)) uris.push(r.valor);
      } else {
        naoEncontradas.push(`${tracks[i].nome} - ${tracks[i].artista}`);
      }
    });
    if (uris.length === 0) {
      return res.status(404).json({ erro: 'Não encontramos nenhuma dessas músicas no Spotify.' });
    }

    // Criar a playlist (endpoint atual da API; /users/{id}/playlists foi removido em 2026)
    const created = await spotifyApi('POST', '/me/playlists', {
      body: {
        name: `Academia: ${ctxName}`,
        description: `Playlist gerada automaticamente pelo Som da Academia em ${new Date().toLocaleDateString('pt-BR')}`,
        public: true,
      },
    });
    if (!created.ok) {
      return res.status(502).json({ erro: `Falha ao criar playlist: ${created.text}` });
    }
    const playlistId = created.data && created.data.id;
    if (!playlistId) return res.status(502).json({ erro: 'O Spotify não devolveu o ID da playlist criada.' });

    // Adicionar as músicas (lotes de 100; /playlists/{id}/tracks foi renomeado para /items)
    let adicionadas = 0;
    for (let i = 0; i < uris.length; i += 100) {
      const chunk = uris.slice(i, i + 100);
      const added = await spotifyApi('POST', `/playlists/${playlistId}/items`, { body: { uris: chunk } });
      if (!added.ok) {
        return res.status(502).json({
          erro: `A playlist foi criada, mas o Spotify recusou adicionar as músicas: ${added.text}`,
          url: created.data.external_urls && created.data.external_urls.spotify,
        });
      }
      adicionadas += chunk.length;
    }

    res.json({
      ok: true,
      url: created.data.external_urls && created.data.external_urls.spotify,
      adicionadas,
      naoEncontradas,
    });
  } catch (err) {
    if (err && err.status === 409) return res.status(409).json({ erro: err.message });
    next(err);
  }
});

// POST /api/spotify/mass-import-text -> pesquisa várias músicas por texto e adiciona
router.post('/mass-import-text', async (req, res, next) => {
  try {
    const contextId = Number(req.body.contextId);
    const rawQueries = req.body.queries;
    if (!Number.isInteger(contextId) || contextId <= 0 || !Array.isArray(rawQueries) || rawQueries.length === 0) {
      return res.status(400).json({ erro: 'contextId e array de queries são obrigatórios.' });
    }
    const queries = rawQueries
      .map((q) => (typeof q === 'string' ? q.trim() : ''))
      .filter(Boolean)
      .slice(0, MAX_IMPORT);
    if (queries.length === 0) return res.status(400).json({ erro: 'Nenhuma linha válida para importar.' });

    const { rows: ctxRows } = await query('SELECT id FROM contexts WHERE id = $1', [contextId]);
    if (!ctxRows[0]) return res.status(404).json({ erro: 'Contexto não encontrado.' });

    // Duas buscas simultâneas no máximo: o Deezer bloqueia rajadas (50 por 5 s)
    const results = await mapLimit(queries, 2, async (q) => {
      const found = await searchTracks(q, 5); // pega mais de 1 porque a versão explícita é descartada
      return found[0] || null;
    });

    const { rows: existing } = await query(
      "SELECT track_id FROM queue_items WHERE context_id = $1 AND status <> 'removida'",
      [contextId]
    );
    const seen = new Set(existing.map((r) => r.track_id));

    const toInsert = [];
    const naoEncontradas = [];
    let duplicadas = 0;
    let falhas = 0;
    results.forEach((r, i) => {
      if (!r.ok) { falhas++; return; }
      if (!r.valor) { naoEncontradas.push(queries[i]); return; }
      if (seen.has(r.valor.trackId)) { duplicadas++; return; }
      seen.add(r.valor.trackId);
      toInsert.push(r.valor);
    });

    if (toInsert.length) {
      // criado_em crescente preserva a ordem em que o texto foi colado
      const agora = Date.now();
      const params = [];
      const tuples = toInsert.map((t, i) => {
        const base = params.length;
        params.push(contextId, t.trackId, t.nome, t.artista, t.capaUrl, t.duracaoMs, agora + i);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, 'pendente', $${base + 7}, $${base + 7})`;
      });
      await query(
        `INSERT INTO queue_items
          (context_id, track_id, nome, artista, capa_url, duracao_ms, status, criado_em, atualizado_em)
         VALUES ${tuples.join(', ')}`,
        params
      );
    }

    res.json({
      ok: true,
      importedCount: toInsert.length,
      total: queries.length,
      duplicadas,
      falhas,
      naoEncontradas,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
