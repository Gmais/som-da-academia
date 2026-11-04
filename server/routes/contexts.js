const express = require('express');
const { query } = require('../db');
const { getActiveContextRow, NOME_CONTEXTO_PEDIDOS } = require('../contextHelper');
const player = require('../player');
const { mapLimit } = require('../util');

const router = express.Router();

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

router.get('/', async (req, res, next) => {
  try {
    const active = await getActiveContextRow(); // antes de listar: cria "Pedidos de Alunos" se ainda não existir
    const { rows: contexts } = await query('SELECT * FROM contexts ORDER BY ordem ASC, id ASC');
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
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido.' });
    const { cor } = req.body;
    const nome = typeof req.body.nome === 'string' ? req.body.nome.trim() : '';

    const { rows: existingRows } = await query('SELECT * FROM contexts WHERE id = $1', [id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ erro: 'Contexto não encontrado.' });

    // A lista que recebe os pedidos do QR code é encontrada pelo nome — renomear faria os
    // pedidos dos alunos caírem numa lista nova e invisível.
    if (nome && nome !== existing.nome && existing.nome === NOME_CONTEXTO_PEDIDOS) {
      return res.status(400).json({ erro: `A lista "${NOME_CONTEXTO_PEDIDOS}" é fixa e não pode ser renomeada.` });
    }

    let aleatorio = existing.aleatorio;
    if (typeof req.body.aleatorio === 'boolean') aleatorio = req.body.aleatorio;

    await query('UPDATE contexts SET nome = $1, cor = $2, aleatorio = $3 WHERE id = $4', [
      nome || existing.nome,
      cor || existing.cor,
      aleatorio,
      id,
    ]);

    if (aleatorio !== existing.aleatorio) {
      // a "próxima" escolhida no modo antigo deixa de valer
      await query('UPDATE player_state SET next_item_id = NULL WHERE id = 1');
    }

    const { rows: updatedRows } = await query('SELECT * FROM contexts WHERE id = $1', [id]);
    res.json(updatedRows[0]);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const nome = typeof req.body.nome === 'string' ? req.body.nome.trim() : '';
    const { cor } = req.body;
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

router.post('/reorder', async (req, res, next) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || order.some((id) => !parseId(id))) {
      return res.status(400).json({ erro: 'O payload deve conter um array "order" de IDs.' });
    }

    for (let i = 0; i < order.length; i++) {
      await query('UPDATE contexts SET ordem = $1 WHERE id = $2', [i, Number(order[i])]);
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido.' });

    const { rows: existingRows } = await query('SELECT nome FROM contexts WHERE id = $1', [id]);
    if (!existingRows[0]) return res.status(404).json({ erro: 'Contexto não encontrado.' });
    if (existingRows[0].nome === NOME_CONTEXTO_PEDIDOS) {
      return res.status(400).json({ erro: `A lista "${NOME_CONTEXTO_PEDIDOS}" é fixa e não pode ser excluída.` });
    }

    // Se a música que toca é desta lista, o som para antes de ela sumir
    await player.stopIfPlayingInContext(id);
    await query('UPDATE player_state SET next_item_id = NULL WHERE id = 1');

    // Deleta os itens da fila primeiro para evitar erro de Foreign Key
    await query('DELETE FROM queue_items WHERE context_id = $1', [id]);
    await query('DELETE FROM contexts WHERE id = $1', [id]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/shuffle', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido.' });

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
    await mapLimit(pendentes, 10, (p, i) =>
      query('UPDATE queue_items SET criado_em = $1 WHERE id = $2', [baseTime + i, p.id])
    );
    await query('UPDATE player_state SET next_item_id = NULL WHERE id = 1');

    res.json({ ok: true, count: pendentes.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
