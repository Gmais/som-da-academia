const express = require('express');
const player = require('../player');

const router = express.Router();

// Erros "esperados" do player (offline, sem oficial, Spotify recusou...) viram JSON com a mensagem
// em português; qualquer outro erro cai no handler central (500).
function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof player.PlayerError) {
        return res.status(err.status).json({ erro: err.message, codigo: err.code });
      }
      next(err);
    }
  };
}

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Só a tela que é o Player Oficial pode usar estas rotas
async function requireOfficial(req, res, next) {
  try {
    if (!(await player.isOfficial(req.body && req.body.clientId))) {
      return res.status(403).json({
        erro: 'Esta tela não é o Player Oficial. Ative "Player Oficial" aqui para tocar.',
        codigo: 'nao_oficial',
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// GET /api/player -> tudo que uma tela precisa: quem é o oficial, o que toca, próxima, posição, volume
router.get('/', handle(async (req, res) => {
  res.json(await player.getView());
}));

// --- Posse do Player Oficial: uma tela por vez ---

router.put('/official', handle(async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ erro: 'clientId é obrigatório.' });
  await player.claimOfficial(clientId);
  res.json({ ownerId: clientId });
}));

router.delete('/official', handle(async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ erro: 'clientId é obrigatório.' });
  await player.releaseOfficial(clientId);
  const view = await player.getView();
  res.json({ ownerId: view.ownerId });
}));

// --- Só o Player Oficial ---

// O oficial avisa o device do Spotify dele (e continua a música se ela estava tocando)
router.put('/device', requireOfficial, handle(async (req, res) => {
  const { clientId, deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ erro: 'deviceId é obrigatório.' });
  res.json(await player.registerDevice(clientId, deviceId));
}));

// Sinal de vida + posição/pausa para as outras telas mostrarem o progresso
router.post('/report', requireOfficial, handle(async (req, res) => {
  const { clientId, deviceId, positionMs, durationMs, paused } = req.body;
  await player.report(clientId, {
    deviceId,
    positionMs: positionMs === undefined || positionMs === null ? NaN : Number(positionMs),
    durationMs: Number(durationMs) || 0,
    paused: typeof paused === 'boolean' ? paused : undefined,
  });
  res.json({ ok: true });
}));

// A música acabou (ou está nos segundos finais): avança para a próxima da lista
router.post('/ended', requireOfficial, handle(async (req, res) => {
  const itemId = parseId(req.body.itemId);
  if (!itemId) return res.status(400).json({ erro: 'itemId é obrigatório.' });
  res.json(await player.trackEnded(itemId, { early: req.body.early === true }));
}));

// --- Qualquer tela controla o som (o servidor fala com o Spotify) ---

router.post('/play', handle(async (req, res) => {
  const itemId = parseId(req.body.itemId);
  if (!itemId) return res.status(400).json({ erro: 'itemId é obrigatório.' });
  const tocando = await player.playItem(itemId);
  res.json({ ok: true, tocando });
}));

router.post('/next', handle(async (req, res) => {
  res.json(await player.skip());
}));

router.post('/pause', handle(async (req, res) => {
  await player.pause();
  res.json({ ok: true });
}));

router.post('/resume', handle(async (req, res) => {
  await player.resume();
  res.json({ ok: true });
}));

router.put('/volume', handle(async (req, res) => {
  const { volumePercent } = req.body;
  if (volumePercent === undefined || volumePercent === null) {
    return res.status(400).json({ erro: 'volumePercent é obrigatório.' });
  }
  res.json(await player.setVolume(volumePercent));
}));

module.exports = router;
