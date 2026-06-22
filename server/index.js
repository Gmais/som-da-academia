const app = require('./app');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  🎚️  Som da Academia rodando em http://localhost:${PORT}`);
  console.log(`  Painel do staff:     http://localhost:${PORT}/staff`);
  console.log(`  Sugestão do aluno:   http://localhost:${PORT}/sugerir\n`);
});
