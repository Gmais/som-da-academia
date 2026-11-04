/**
 * Executa fn(item, índice) para cada item com no máximo `limite` chamadas ao mesmo
 * tempo, preservando a ordem dos resultados. Nunca rejeita: cada posição do resultado
 * é { ok: true, valor } ou { ok: false, erro }.
 */
async function mapLimit(items, limite, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { ok: true, valor: await fn(items[i], i) };
      } catch (erro) {
        results[i] = { ok: false, erro };
      }
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limite, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { mapLimit, sleep };
