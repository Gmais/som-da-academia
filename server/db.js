const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.join(__dirname, '..', 'gym.db');
const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS contexts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    hora_inicio TEXT NOT NULL,   -- 'HH:MM'
    hora_fim TEXT NOT NULL,      -- 'HH:MM'
    cor TEXT NOT NULL DEFAULT '#E8A33D',
    ordem INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS queue_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context_id INTEGER NOT NULL REFERENCES contexts(id),
    spotify_track_id TEXT NOT NULL,
    nome TEXT NOT NULL,
    artista TEXT NOT NULL,
    capa_url TEXT,
    duracao_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'pendente', -- pendente | tocando | tocada | removida
    criado_em INTEGER NOT NULL,
    atualizado_em INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS suggestion_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL,
    criado_em INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_queue_context_status ON queue_items(context_id, status);
  CREATE INDEX IF NOT EXISTS idx_suggestion_log_token ON suggestion_log(token, criado_em);
`);

// Seed: só roda se a tabela de contextos estiver vazia, pra não duplicar em restarts.
const count = db.prepare('SELECT COUNT(*) as n FROM contexts').get().n;
if (count === 0) {
  const insert = db.prepare(
    'INSERT INTO contexts (nome, hora_inicio, hora_fim, cor, ordem) VALUES (?, ?, ?, ?, ?)'
  );
  const seed = () => {
    db.exec('BEGIN');
    try {
      insert.run('Manhã leve', '06:00', '09:00', '#2F6F62', 1);
      insert.run('Treino pesado', '09:00', '12:00', '#E8A33D', 2);
      insert.run('Tarde', '12:00', '17:00', '#4A4540', 3);
      insert.run('Treino pesado (noite)', '17:00', '21:00', '#E8A33D', 4);
      insert.run('Alongamento / Funcional', '21:00', '22:30', '#2F6F62', 5);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
  seed();
  console.log('Contextos padrão criados. Edite os horários no painel quando quiser.');
}

module.exports = db;
