const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: process.env.POSTGRES_URL && process.env.POSTGRES_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

let schemaReady = null;

/**
 * Cria as tabelas (se ainda não existirem) e faz o seed dos contextos padrão.
 * Roda automaticamente na primeira query — não precisa de um passo de migração
 * manual separado, o que é importante em ambiente serverless (Vercel).
 */
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS contexts (
          id SERIAL PRIMARY KEY,
          nome TEXT NOT NULL,
          hora_inicio TEXT NOT NULL,
          hora_fim TEXT NOT NULL,
          cor TEXT NOT NULL DEFAULT '#E8A33D',
          ordem INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS queue_items (
          id SERIAL PRIMARY KEY,
          context_id INTEGER NOT NULL REFERENCES contexts(id),
          spotify_track_id TEXT NOT NULL,
          nome TEXT NOT NULL,
          artista TEXT NOT NULL,
          capa_url TEXT,
          duracao_ms BIGINT,
          status TEXT NOT NULL DEFAULT 'pendente',
          criado_em BIGINT NOT NULL,
          atualizado_em BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS suggestion_log (
          id SERIAL PRIMARY KEY,
          token TEXT NOT NULL,
          criado_em BIGINT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_queue_context_status ON queue_items(context_id, status);
        CREATE INDEX IF NOT EXISTS idx_suggestion_log_token ON suggestion_log(token, criado_em);
      `);

      const { rows } = await pool.query('SELECT COUNT(*) AS n FROM contexts');
      if (Number(rows[0].n) === 0) {
        await pool.query(
          `INSERT INTO contexts (nome, hora_inicio, hora_fim, cor, ordem) VALUES
            ('Manhã leve', '06:00', '09:00', '#2F6F62', 1),
            ('Treino pesado', '09:00', '12:00', '#E8A33D', 2),
            ('Tarde', '12:00', '17:00', '#4A4540', 3),
            ('Treino pesado (noite)', '17:00', '21:00', '#E8A33D', 4),
            ('Alongamento / Funcional', '21:00', '22:30', '#2F6F62', 5)`
        );
        console.log('Contextos padrão criados. Edite os horários no painel quando quiser.');
      }
    })();
  }
  return schemaReady;
}

/**
 * Executa uma query já garantindo que o schema existe.
 * Uso: const { rows } = await query('SELECT * FROM contexts WHERE id = $1', [id]);
 */
async function query(text, params) {
  await ensureSchema();
  return pool.query(text, params);
}

module.exports = { query, pool, ensureSchema };
