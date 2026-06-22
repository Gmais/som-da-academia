try {
    const resultados = await searchTracks(q);
    res.json({ resultados });
  } catch (err) {
    console.error(err);
    res.status(502).json({
      erro: 'Não foi possível buscar no Spotify agora.',
      detalhe: err.message,
    });
  }
