const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const { getActiveContext } = require('../contextHelper');

const router = express.Router();

const COOKIE_NAME = 'sda_token';
const JANELA_ANTI_REPETICAO_MIN = 120; // mesma música não pode repetir antes disso, por contexto
const JANELA_LIMITE_AMOSTRA_MIN = 30; // janela do limite de sugestões por aluno
const LIMITE_SUGESTOES_POR_JANELA = 3;

function getOrCreateToken(req, res) {
  let token = req.cookies[COOKIE_NAME];
  if (!token) {
    token = nanoid();
    res.cookie(COOKIE_NAME, token, {
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 dias
      httpOnly: true,
      sameSite: 'lax',
    });
  }
  return token;
}

function getActiveContextRow() {
  const contexts = db.prepare('SELECT * FROM contexts ORDER BY ordem ASC').all();
  return getActiveContext(contexts);
}

// GET /api/queue?contextId=N -> fila do contexto pedido (ou do ativo, por padrão) + contagem dos outros
router.get('/', (req, res) => {
  const contexts = db.prepare('SELECT * FROM contexts ORDER BY ordem ASC').all();
  const active = getActiveContext(contexts);

  const requestedId = req.query.contextId ? Number(req.query.contextId) : active?.id;

  const counts = db
    .prepare(
      `SELECT context_id, COUNT(*) as n FROM queue_items
       WHERE status IN ('pendente','tocando') GROUP BY context_id`
    )
    .all();
  const countByContext = Object.fromEntries(counts.map((c) => [c.context_id, c.n]));

  const items = requestedId
    ? db
        .prepare(
          `SELECT * FROM queue_items
           WHERE context_id = ? AND status IN ('pendente','tocando')
           ORDER BY (status = 'tocando') DESC, criado_em ASC`
        )
        .all(requestedId)
    : [];

  res.json({
    activeContext: active,
    viewingContextId: requestedId || null,
    contexts: contexts.map((c) => ({ ...c, naFila: countByContext[c.id] || 0 })),
    items,
  });
});

// POST /api/suggestions -> aluno sugere uma música. Entra direto na fila do contexto
// ativo no momento, depois de passar pelos guardrails automáticos.
router.post('/suggestions', (req, res) => {
  const { spotifyTrackId, nome, artista, capaUrl, duracaoMs } = req.body;

  if (!spotifyTrackId || !nome || !artista) {
    return res.status(400).json({ erro: 'Música inválida.' });
  }

  const active = getActiveContextRow();
  if (!active) {
    return res.status(409).json({ erro: 'Nenhum contexto de horário configurado ainda.' });
  }

  const token = getOrCreateToken(req, res);
  const agora = Date.now();

  // Guardrail 1: limite de sugestões por aluno numa janela de tempo (evita spam/flood)
  const desde = agora - JANELA_LIMITE_AMOSTRA_MIN * 60 * 1000;
  const totalRecente = db
    .prepare('SELECT COUNT(*) as n FROM suggestion_log WHERE token = ? AND criado_em > ?')
    .get(token, desde).n;

  if (totalRecente >= LIMITE_SUGESTOES_POR_JANELA) {
    return res.status(429).json({
      erro: `Você já sugeriu ${LIMITE_SUGESTOES_POR_JANELA} músicas nos últimos ${JANELA_LIMITE_AMOSTRA_MIN} minutos. Dá um tempo e tenta de novo daqui a pouco — assim todo mundo tem vez :)`,
    });
  }

  // Guardrail 2: anti-repetição — mesma música não pode ter sido sugerida/tocada
  // recentemente neste mesmo contexto.
  const desdeRepeticao = agora - JANELA_ANTI_REPETICAO_MIN * 60 * 1000;
  const jaSugerida = db
    .prepare(
      `SELECT COUNT(*) as n FROM queue_items
       WHERE context_id = ? AND spotify_track_id = ? AND status != 'removida' AND criado_em > ?`
    )
    .get(active.id, spotifyTrackId, desdeRepeticao).n;

  if (jaSugerida > 0) {
    return res.status(409).json({
      erro: 'Essa música já está (ou já foi tocada) na fila recente. Que tal sugerir outra?',
    });
  }

  // Guardrail 3 (já aplicado na busca): conteúdo explícito nunca aparece nos resultados.

  const info = db
    .prepare(
      `INSERT INTO queue_items
        (context_id, spotify_track_id, nome, artista, capa_url, duracao_ms, status, criado_em, atualizado_em)
       VALUES (?, ?, ?, ?, ?, ?, 'pendente', ?, ?)`
    )
    .run(active.id, spotifyTrackId, nome, artista, capaUrl || null, duracaoMs || null, agora, agora);

  db.prepare('INSERT INTO suggestion_log (token, criado_em) VALUES (?, ?)').run(token, agora);

  const posicao = db
    .prepare(
      `SELECT COUNT(*) as n FROM queue_items
       WHERE context_id = ? AND status IN ('pendente','tocando') AND criado_em <= ?`
    )
    .get(active.id, agora).n;

  res.status(201).json({
    ok: true,
    contexto: active.nome,
    posicaoNaFila: posicao,
    queueItemId: info.lastInsertRowid,
  });
});

// PATCH /api/queue/:id -> staff atualiza status (tocando | tocada | removida)
router.patch('/:id', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validos = ['pendente', 'tocando', 'tocada', 'removida'];
  if (!validos.includes(status)) {
    return res.status(400).json({ erro: 'Status inválido.' });
  }

  const existing = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ erro: 'Item não encontrado.' });

  db.prepare('UPDATE queue_items SET status = ?, atualizado_em = ? WHERE id = ?').run(
    status,
    Date.now(),
    id
  );

  res.json({ ok: true });
});

module.exports = router;
