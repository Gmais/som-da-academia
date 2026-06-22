const express = require('express');
const { searchTracks } = require('../spotify');

const router = express.Router();

router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) {
    return res.json({ resultados: [] });
  }

  try {
    const resultados = await searchTracks(q);
    res.json({ resultados });
  } catch (err) {
    console.error(err);
    res.status(502).json({
      erro: 'Não foi possível buscar no Spotify agora. Verifique as credenciais no .env.',
    });
  }
});

module.exports = router;
