require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const contextsRouter = require('./routes/contexts');
const searchRouter = require('./routes/search');
const queueRouter = require('./routes/queue');
const qrcodeRouter = require('./routes/qrcode');

const app = express();

app.use(cors());
app.use(express.json());
app.use(cookieParser());

app.use('/api/contexts', contextsRouter);
app.use('/api/search', searchRouter);
app.use('/api/qrcode', qrcodeRouter);
// queueRouter cuida de GET /api/queue, POST /api/queue/suggestions e PATCH /api/queue/:id
app.use('/api/queue', queueRouter);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  🎚️  Som da Academia rodando em http://localhost:${PORT}`);
  console.log(`  Painel do staff:     http://localhost:${PORT}/staff`);
  console.log(`  Sugestão do aluno:   http://localhost:${PORT}/sugerir\n`);
});
