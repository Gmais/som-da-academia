const express = require('express');
const { query } = require('../db');
const { getActiveContextRow } = require('../contextHelper');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows: contexts } = await query('SELECT * FROM contexts ORDER BY ordem ASC');
    const active = await getActiveContextRow();
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
    const { nome, cor } = req.body;

    const { rows: existingRows } = await query('SELECT * FROM contexts WHERE id = $1', [id]);
    if (!existingRows[0]) return res.status(404).json({ erro: 'Contexto não encontrado.' });

    await query(
      'UPDATE contexts SET nome = $1, cor = $2 WHERE id = $3',
      [nome || existingRows[0].nome, cor || existingRows[0].cor, id]
    );

    const { rows: updatedRows } = await query('SELECT * FROM contexts WHERE id = $1', [id]);
    res.json(updatedRows[0]);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { nome, cor } = req.body;
    if (!nome) {
      return res.status(400).json({ erro: 'Nome é obrigatório.' });
    }
    
    const { rows: maxRows } = await query('SELECT COALESCE(MAX(ordem), 0) as max_ordem FROM contexts');
    const nextOrdem = Number(maxRows[0].max_ordem) + 1;

    const { rows: inserted } = await query(
      `INSERT INTO contexts (nome, hora_inicio, hora_fim, cor, ordem)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [nome, '00:00', '23:59', cor || '#3E9B77', nextOrdem]
    );

    res.status(201).json(inserted[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Deleta os itens da fila primeiro para evitar erro de Foreign Key
    await query('DELETE FROM queue_items WHERE context_id = $1', [id]);
    
    const { rowCount } = await query('DELETE FROM contexts WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ erro: 'Contexto não encontrado.' });
    
    res.json({ ok: true });
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
