require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const contextsRouter = require('./routes/contexts');
const searchRouter = require('./routes/search');
const queueRouter = require('./routes/queue');
const qrcodeRouter = require('./routes/qrcode');
const debugRouter = require('./routes/debug');

const app = express();

app.use(cors());
app.use(express.json());
app.use(cookieParser());

app.use('/api/contexts', contextsRouter);
app.use('/api/search', searchRouter);
app.use('/api/qrcode', qrcodeRouter);
app.use('/api/_debug', debugRouter); // TEMPORÁRIO — remover depois do diagnóstico
// queueRouter cuida de GET /api/queue, POST /api/queue/suggestions e PATCH /api/queue/:id
app.use('/api/queue', queueRouter);

// Servir os arquivos estáticos também localmente (no Vercel, o próprio
// CDN já serve a pasta /public diretamente, sem passar por aqui).
app.get('/staff', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'staff', 'index.html'));
});

app.get('/sugerir', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'sugerir', 'index.html'));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.redirect('/staff');
});

// Handler de erro central — qualquer rota que chamar next(err) cai aqui.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ erro: 'Erro interno. Verifique os logs do servidor.' });
});

module.exports = app;
