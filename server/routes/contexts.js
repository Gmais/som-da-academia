const express = require('express');
const { query } = require('../db');
const { getActiveContext } = require('../contextHelper');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows: contexts } = await query('SELECT * FROM contexts ORDER BY ordem ASC');
    const active = getActiveContext(contexts);
    res.json({
      contexts,
      activeContextId: active ? active.id : null,
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { nome, hora_inicio, hora_fim, cor } = req.body;

    const { rows: existingRows } = await query('SELECT * FROM contexts WHERE id = $1', [id]);
    if (!existingRows[0]) return res.status(404).json({ erro: 'Contexto não encontrado.' });

    await query(
      `UPDATE contexts SET
        nome = COALESCE($1, nome),
        hora_inicio = COALESCE($2, hora_inicio),
        hora_fim = COALESCE($3, hora_fim),
        cor = COALESCE($4, cor)
       WHERE id = $5`,
      [nome ?? null, hora_inicio ?? null, hora_fim ?? null, cor ?? null, id]
    );

    const { rows: updatedRows } = await query('SELECT * FROM contexts WHERE id = $1', [id]);
    res.json(updatedRows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
