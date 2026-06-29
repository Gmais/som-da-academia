const { query } = require('./db');

/**
 * Retorna o contexto "Pedidos de Alunos". Se não existir, cria um.
 */
async function getActiveContextRow() {
  const { rows } = await query("SELECT * FROM contexts WHERE nome = 'Pedidos de Alunos' LIMIT 1");
  if (rows.length > 0) return rows[0];

  // Cria se não existir
  const { rows: maxRows } = await query('SELECT COALESCE(MAX(ordem), 0) as max_ordem FROM contexts');
  const nextOrdem = Number(maxRows[0].max_ordem) + 1;

  const { rows: inserted } = await query(
    `INSERT INTO contexts (nome, hora_inicio, hora_fim, cor, ordem)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    ['Pedidos de Alunos', '00:00', '23:59', '#3b82f6', nextOrdem]
  );
  return inserted[0];
}

module.exports = {
  getActiveContextRow,
};
