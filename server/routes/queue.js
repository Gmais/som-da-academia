const express = require('express');
const { nanoid } = require('nanoid');
const { query } = require('../db');
const { getActiveContextRow } = require('../contextHelper');
const player = require('../player');

const router = express.Router();

const COOKIE_NAME = 'sda_token';
const JANELA_ANTI_REPETICAO_MIN = 120;
const JANELA_LIMITE_AMOSTRA_MIN = 30;
const LIMITE_SUGESTOES_POR_JANELA = 3;

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

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

// GET /api/queue?contextId=N -> fila do contexto pedido (ou do ativo, por padrão) + contagem dos outros
router.get('/', async (req, res, next) => {
  try {
    let requestedId = null;
    if (req.query.contextId !== undefined) {
      requestedId = parseId(req.query.contextId);
      if (!requestedId) return res.status(400).json({ erro: 'contextId inválido.' });
    }

    const active = await getActiveContextRow(); // antes de listar: cria "Pedidos de Alunos" se ainda não existir
    const { rows: contexts } = await query('SELECT * FROM contexts ORDER BY ordem ASC, id ASC');
    if (!requestedId) requestedId = active ? active.id : null;

    const { rows: counts } = await query(
      `SELECT context_id, COUNT(*) as n FROM queue_items
       WHERE status IN ('pendente','tocando') GROUP BY context_id`
    );
    const countByContext = Object.fromEntries(counts.map((c) => [c.context_id, Number(c.n)]));

    let items = [];
    if (requestedId) {
      const { rows } = await query(
        `SELECT * FROM queue_items
         WHERE context_id = $1 AND status IN ('pendente','tocando','tocada')
         ORDER BY
           (status = 'tocando') DESC,
           (status = 'pendente') DESC,
           criado_em ASC, id ASC`,
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
    const { trackId, nome, artista, capaUrl, duracaoMs } = req.body;
    const contextId = parseId(req.body.contextId);

    if (!contextId || !trackId || !nome || !artista) {
      return res.status(400).json({ erro: 'Dados incompletos.' });
    }

    const { rows: contextRows } = await query('SELECT * FROM contexts WHERE id = $1', [contextId]);
    if (!contextRows[0]) return res.status(404).json({ erro: 'Contexto não encontrado.' });

    const { rows: dupRows } = await query(
      `SELECT COUNT(*) as n FROM queue_items
       WHERE context_id = $1 AND track_id = $2 AND status IN ('pendente','tocando')`,
      [contextId, String(trackId)]
    );
    if (Number(dupRows[0].n) > 0) {
      return res.status(409).json({ erro: 'Essa música já está na fila desta lista.' });
    }

    const agora = Date.now();
    const { rows: insertedRows } = await query(
      `INSERT INTO queue_items
        (context_id, track_id, nome, artista, capa_url, duracao_ms, status, criado_em, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, $6, 'pendente', $7, $7)
       RETURNING id`,
      [contextId, String(trackId), nome, artista, capaUrl || null, duracaoMs || null, agora]
    );

    res.status(201).json({ ok: true, queueItemId: insertedRows[0].id });
  } catch (err) {
    next(err);
  }
});

// POST /api/queue/suggestions -> aluno sugere uma música.
router.post('/suggestions', async (req, res, next) => {
  try {
    const { trackId, nome, artista, capaUrl, duracaoMs, matricula } = req.body;

    if (!trackId || !nome || !artista || !matricula) {
      return res.status(400).json({ erro: 'Dados incompletos. Matrícula é obrigatória.' });
    }
    if (!/^\d{4}$/.test(matricula)) {
      return res.status(400).json({ erro: 'Matrícula inválida. Deve conter 4 números.' });
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
      [active.id, String(trackId), desdeRepeticao]
    );
    if (Number(repeatRows[0].n) > 0) {
      return res.status(409).json({
        erro: 'Essa música já está (ou já foi tocada) na fila recente. Que tal sugerir outra?',
      });
    }

    // Guardrail 3 (já aplicado na busca): conteúdo explícito nunca aparece nos resultados.

    const { rows: insertedRows } = await query(
      `INSERT INTO queue_items
        (context_id, track_id, nome, artista, capa_url, duracao_ms, status, criado_em, atualizado_em, matricula)
       VALUES ($1, $2, $3, $4, $5, $6, 'pendente', $7, $7, $8)
       RETURNING id`,
      [active.id, String(trackId), nome, artista, capaUrl || null, duracaoMs || null, agora, matricula]
    );

    await query('INSERT INTO suggestion_log (token, criado_em, matricula) VALUES ($1, $2, $3)', [token, agora, matricula]);

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

// PATCH /api/queue/:id -> staff atualiza status (tocando | tocada | removida | pendente)
//  - 'tocando' toca de verdade (o servidor comanda o Player Oficial), então banco e som ficam coerentes.
//  - Tirar de 'tocando' a música que está no ar (pular, marcar tocada, remover) faz o som avançar
//    para a próxima da lista, ou parar se não houver próxima.
router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido.' });
    const { status } = req.body;

    const validos = ['pendente', 'tocando', 'tocada', 'removida'];
    if (!validos.includes(status)) {
      return res.status(400).json({ erro: 'Status inválido.' });
    }

    const { rows: existingRows } = await query('SELECT * FROM queue_items WHERE id = $1', [id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ erro: 'Item não encontrado.' });
    if (status === existing.status) return res.json({ ok: true });

    if (status === 'tocando') {
      await player.playItem(id);
      return res.json({ ok: true });
    }

    await query('UPDATE queue_items SET status = $1, atualizado_em = $2 WHERE id = $3', [status, Date.now(), id]);

    let avanco = null;
    let aviso = null;
    if (existing.status === 'tocando') {
      try {
        avanco = await player.currentLeft(existing);
      } catch (err) {
        if (!(err instanceof player.PlayerError)) throw err;
        aviso = err.message; // o status já mudou; o som não conseguiu avançar
      }
    }

    res.json({ ok: true, avanco, aviso });
  } catch (err) {
    if (err instanceof player.PlayerError) {
      return res.status(err.status).json({ erro: err.message, codigo: err.code });
    }
    next(err);
  }
});

module.exports = router;
