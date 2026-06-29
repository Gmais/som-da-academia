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

router.post('/:id/shuffle', async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Pega todas as músicas pendentes desse contexto
    const { rows: pendentes } = await query(
      `SELECT id FROM queue_items 
       WHERE context_id = $1 AND status = 'pendente'`,
      [id]
    );

    if (pendentes.length < 2) {
      return res.json({ ok: true, message: 'Nada para embaralhar' });
    }

    // Embaralha o array (Fisher-Yates)
    for (let i = pendentes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pendentes[i], pendentes[j]] = [pendentes[j], pendentes[i]];
    }

    // Atualiza a ordem alterando o criado_em
    const baseTime = Date.now();
    for (let i = 0; i < pendentes.length; i++) {
      await query(
        `UPDATE queue_items SET criado_em = $1 WHERE id = $2`,
        [baseTime + i, pendentes[i].id]
      );
    }

    res.json({ ok: true, count: pendentes.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
