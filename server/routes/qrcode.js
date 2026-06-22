const express = require('express');
const QRCode = require('qrcode');

const router = express.Router();

router.get('/', async (req, res) => {
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  const target = `${publicUrl.replace(/\/$/, '')}/sugerir`;

  try {
    const svg = await QRCode.toString(target, { type: 'svg', margin: 1, color: { dark: '#1C1A18', light: '#F7F5F1' } });
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Falha ao gerar QR code.' });
  }
});

module.exports = router;
