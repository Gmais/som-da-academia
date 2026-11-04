const searchInput = document.getElementById('search-input');
const matriculaInput = document.getElementById('matricula-input');
const resultsEl = document.getElementById('results');
const contextNameEl = document.getElementById('context-name');
const toastEl = document.getElementById('toast');

let debounceTimer = null;
let lastQuery = '';

function fmtDuration(ms) {
  if (!ms) return '--:--';
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function showToast(message, type = 'ok') {
  toastEl.textContent = message;
  toastEl.className = `toast ${type === 'erro' ? 'toast--error' : ''}`;
  toastEl.hidden = false;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => { toastEl.hidden = true; }, 4500);
}

async function loadActiveContext() {
  try {
    const res = await fetch('/api/contexts');
    const data = await res.json();
    const active = data.contexts.find((c) => c.id === data.activeContextId);
    contextNameEl.textContent = active ? active.nome : '—';
  } catch {
    contextNameEl.textContent = '—';
  }
}

function renderResults(resultados) {
  if (!resultados.length) {
    resultsEl.innerHTML = lastQuery
      ? '<div class="empty-hint">Nenhum resultado. Tenta outro termo de busca.</div>'
      : '';
    return;
  }

  resultsEl.innerHTML = resultados
    .map(
      (r) => `
      <div class="result">
        <img class="result__cover" src="${escapeHtml(r.capaUrl || '')}" alt="" loading="lazy" />
        <div class="result__info">
          <div class="result__name">${escapeHtml(r.nome)}</div>
          <div class="result__artist">${escapeHtml(r.artista)}</div>
        </div>
        <span class="result__duration">${fmtDuration(r.duracaoMs)}</span>
        <button data-track-id="${escapeHtml(r.trackId)}"
                data-nome="${escapeHtml(r.nome)}"
                data-artista="${escapeHtml(r.artista)}"
                data-capa="${escapeHtml(r.capaUrl || '')}"
                data-duracao="${escapeHtml(r.duracaoMs || '')}">Sugerir</button>
      </div>`
    )
    .join('');
}

// Escapa também aspas: os textos vão para dentro de atributos (data-nome="...") e
// um título com " (ex.: "Heroes") quebrava o botão Sugerir.
function escapeHtml(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const q = searchInput.value.trim();
  lastQuery = q;

  if (q.length < 2) {
    resultsEl.innerHTML = '';
    return;
  }

  debounceTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (lastQuery === q) renderResults(data.resultados || []);
    } catch {
      resultsEl.innerHTML = '<div class="empty-hint">Erro ao buscar. Tenta novamente.</div>';
    }
  }, 350);
});

resultsEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-track-id]');
  if (!btn) return;

  const matricula = matriculaInput.value.trim();
  if (!/^\d{4}$/.test(matricula)) {
    showToast('Digite sua matrícula com 4 números para sugerir.', 'erro');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Enviando…';

  try {
    const res = await fetch('/api/queue/suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trackId: btn.dataset.trackId,
        nome: btn.dataset.nome,
        artista: btn.dataset.artista,
        capaUrl: btn.dataset.capa,
        duracaoMs: Number(btn.dataset.duracao) || null,
        matricula: matricula,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.erro || 'Não foi possível enviar a sugestão.', 'erro');
      btn.disabled = false;
      btn.textContent = 'Sugerir';
      return;
    }

    showToast(`Sugestão enviada! Você está na posição ${data.posicaoNaFila} da fila de ${data.contexto}.`);
    btn.textContent = 'Enviada ✓';
  } catch {
    showToast('Erro de conexão. Tenta de novo.', 'erro');
    btn.disabled = false;
    btn.textContent = 'Sugerir';
  }
});

loadActiveContext();
setInterval(loadActiveContext, 1000 * 30);