const express = require('express');
const db = require('../db');
const { getActiveContext } = require('../contextHelper');

const router = express.Router();

router.get('/', (req, res) => {
  const contexts = db.prepare('SELECT * FROM contexts ORDER BY ordem ASC').all();
  const active = getActiveContext(contexts);
  res.json({
    contexts,
    activeContextId: active ? active.id : null,
  });
});

router.patch('/:id', (req, res) => {
  const { id } = req.params;
  const { nome, hora_inicio, hora_fim, cor } = req.body;

  const existing = db.prepare('SELECT * FROM contexts WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ erro: 'Contexto não encontrado.' });

  db.prepare(
    `UPDATE contexts SET
      nome = COALESCE(?, nome),
      hora_inicio = COALESCE(?, hora_inicio),
      hora_fim = COALESCE(?, hora_fim),
      cor = COALESCE(?, cor)
     WHERE id = ?`
  ).run(nome ?? null, hora_inicio ?? null, hora_fim ?? null, cor ?? null, id);

  const updated = db.prepare('SELECT * FROM contexts WHERE id = ?').get(id);
  res.json(updated);
});

module.exports = router;
