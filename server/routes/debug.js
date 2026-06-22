const express = require('express');
const router = express.Router();

// Rota TEMPORÁRIA de diagnóstico. Remover depois do teste.
router.get('/spotify-search', async (req, res) => {
  const q = req.query.q || 'eye of the tiger';
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ erro: 'SPOTIFY_CLIENT_ID/SECRET não configurados.' });
  }

  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const tokenText = await tokenRes.text();
    if (!tokenRes.ok) {
      return res.status(502).json({ etapa: 'token', status: tokenRes.status, resposta: tokenText });
    }
    const { access_token } = JSON.parse(tokenText);

    const searchUrl = new URL('https://api.spotify.com/v1/search');
    searchUrl.searchParams.set('q', q);
    searchUrl.searchParams.set('type', 'track');
    searchUrl.searchParams.set('limit', '10');

    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const searchText = await searchRes.text();

    return res.status(searchRes.ok ? 200 : 502).json({
      etapa: 'search',
      status: searchRes.status,
      resposta: searchRes.ok ? JSON.parse(searchText) : searchText,
    });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
