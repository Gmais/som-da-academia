const express = require('express');
const { nanoid } = require('nanoid');
const { query } = require('../db');
const { getActiveContext } = require('../contextHelper');

const router = express.Router();

const COOKIE_NAME = 'sda_token';
const JANELA_ANTI_REPETICAO_MIN = 120;
const JANELA_LIMITE_AMOSTRA_MIN = 30;
const LIMITE_SUGESTOES_POR_JANELA = 3;

function getOrCreateToken(req, res) {
  let token = req.cookies[COOKIE_NAME];
  if (!token) {
    token = nanoid();
    res.cookie(COOKIE_NAME, token, {
      maxAge: 1000 * 60 * 60 * 24 * 30,
      httpOnly: true,
      sameSite: 'lax',
    });
  }
  return token;
}

async function getActiveContextRow() {
  const { rows: contexts } = await query('SELECT * FROM contexts ORDER BY ordem ASC');
  return getActiveContext(contexts);
}

// GET /api/queue?contextId=N -> fila do contexto pedido (ou do ativo, por padrão) + contagem dos outros
router.get('/', async (req, res, next) => {
  try {
    const { rows: contexts } = await query('SELECT * FROM contexts ORDER BY ordem ASC');
    const active = getActiveContext(contexts);

    const requestedId = req.query.contextId ? Number(req.query.contextId) : active?.id;

    const { rows: counts } = await query(
      `SELECT context_id, COUNT(*) as n FROM queue_items
       WHERE status IN ('pendente','tocando') GROUP BY context_id`
    );
    const countByContext = Object.fromEntries(counts.map((c) => [c.context_id, Number(c.n)]));

    let items = [];
    if (requestedId) {
      const { rows } = await query(
        `SELECT * FROM queue_items
         WHERE context_id = $1 AND status IN ('pendente','tocando')
         ORDER BY (status = 'tocando') DESC, criado_em ASC`,
        [requestedId]
      );
      items = rows;
    }

    res.json({
      activeContext: active,
      viewingContextId: requestedId || null,
      contexts: contexts.map((c) => ({ ...c, naFila: countByContext[c.id] || 0 })),
      items,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/queue/add -> staff adiciona música direto num contexto (sem guardrails de aluno)
router.post('/add', async (req, res, next) => {
  try {
    const { contextId, trackId, nome, artista, capaUrl, duracaoMs } = req.body;

    if (!contextId || !trackId || !nome || !artista) {
      return res.status(400).json({ erro: 'Dados incompletos.' });
    }

    const { rows: contextRows } = await query('SELECT * FROM contexts WHERE id = $1', [contextId]);
    if (!contextRows[0]) return res.status(404).json({ erro: 'Contexto não encontrado.' });

    const agora = Date.now();
    const { rows: insertedRows } = await query(
      `INSERT INTO queue_items
        (context_id, track_id, nome, artista, capa_url, duracao_ms, status, criado_em, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, $6, 'pendente', $7, $7)
       RETURNING id`,
      [contextId, trackId, nome, artista, capaUrl || null, duracaoMs || null, agora]
    );

    res.status(201).json({ ok: true, queueItemId: insertedRows[0].id });
  } catch (err) {
    next(err);
  }
});

// POST /api/queue/suggestions -> aluno sugere uma música.
router.post('/suggestions', async (req, res, next) => {
  try {
    const { trackId, nome, artista, capaUrl, duracaoMs } = req.body;

    if (!trackId || !nome || !artista) {
      return res.status(400).json({ erro: 'Música inválida.' });
    }

    const active = await getActiveContextRow();
    if (!active) {
      return res.status(409).json({ erro: 'Nenhum contexto de horário configurado ainda.' });
    }

    const token = getOrCreateToken(req, res);
    const agora = Date.now();

    // Guardrail 1: limite de sugestões por aluno numa janela de tempo
    const desde = agora - JANELA_LIMITE_AMOSTRA_MIN * 60 * 1000;
    const { rows: recentRows } = await query(
      'SELECT COUNT(*) as n FROM suggestion_log WHERE token = $1 AND criado_em > $2',
      [token, desde]
    );
    if (Number(recentRows[0].n) >= LIMITE_SUGESTOES_POR_JANELA) {
      return res.status(429).json({
        erro: `Você já sugeriu ${LIMITE_SUGESTOES_POR_JANELA} músicas nos últimos ${JANELA_LIMITE_AMOSTRA_MIN} minutos. Dá um tempo e tenta de novo daqui a pouco — assim todo mundo tem vez :)`,
      });
    }

    // Guardrail 2: anti-repetição
    const desdeRepeticao = agora - JANELA_ANTI_REPETICAO_MIN * 60 * 1000;
    const { rows: repeatRows } = await query(
      `SELECT COUNT(*) as n FROM queue_items
       WHERE context_id = $1 AND track_id = $2 AND status != 'removida' AND criado_em > $3`,
      [active.id, trackId, desdeRepeticao]
    );
    if (Number(repeatRows[0].n) > 0) {
      return res.status(409).json({
        erro: 'Essa música já está (ou já foi tocada) na fila recente. Que tal sugerir outra?',
      });
    }

    // Guardrail 3 (já aplicado na busca): conteúdo explícito nunca aparece nos resultados.

    const { rows: insertedRows } = await query(
      `INSERT INTO queue_items
        (context_id, track_id, nome, artista, capa_url, duracao_ms, status, criado_em, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, $6, 'pendente', $7, $7)
       RETURNING id`,
      [active.id, trackId, nome, artista, capaUrl || null, duracaoMs || null, agora]
    );

    await query('INSERT INTO suggestion_log (token, criado_em) VALUES ($1, $2)', [token, agora]);

    const { rows: posicaoRows } = await query(
      `SELECT COUNT(*) as n FROM queue_items
       WHERE context_id = $1 AND status IN ('pendente','tocando') AND criado_em <= $2`,
      [active.id, agora]
    );

    res.status(201).json({
      ok: true,
      contexto: active.nome,
      posicaoNaFila: Number(posicaoRows[0].n),
      queueItemId: insertedRows[0].id,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/queue/:id -> staff atualiza status (tocando | tocada | removida)
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validos = ['pendente', 'tocando', 'tocada', 'removida'];
    if (!validos.includes(status)) {
      return res.status(400).json({ erro: 'Status inválido.' });
    }

    const { rows: existingRows } = await query('SELECT * FROM queue_items WHERE id = $1', [id]);
    if (!existingRows[0]) return res.status(404).json({ erro: 'Item não encontrado.' });

    if (status === 'tocando') {
      // Quando marcar uma como tocando, marca qualquer outra 'tocando' do mesmo contexto como 'tocada'
      await query(
        "UPDATE queue_items SET status = 'tocada', atualizado_em = $1 WHERE context_id = $2 AND status = 'tocando' AND id != $3",
        [Date.now(), existingRows[0].context_id, id]
      );
    }

    await query('UPDATE queue_items SET status = $1, atualizado_em = $2 WHERE id = $3', [
      status,
      Date.now(),
      id,
    ]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;