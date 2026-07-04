const express = require('express');
const { query } = require('../db');

const router = express.Router();

// GET /api/cron/reset-diario
// Chamado pelo Vercel Cron às 23:59 (BRT) todo dia.
// Vercel Cron Jobs sempre disparam via HTTP GET, por isso a rota precisa ser GET.
// Volta todas as músicas 'tocada' para 'pendente', zerando o histórico do dia.
router.get('/reset-diario', async (req, res, next) => {
  try {
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization;
    if (secret && authHeader !== `Bearer ${secret}`) {
      return res.status(401).json({ erro: 'Não autorizado.' });
    }

    const { rowCount } = await query(
      "UPDATE queue_items SET status = 'pendente', atualizado_em = $1 WHERE status != 'pendente'",
      [Date.now()]
    );

    console.log(`[reset-diario] ${rowCount} músicas voltaram para a fila (pendente).`);
    res.json({ ok: true, resetadas: rowCount });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
