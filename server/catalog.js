const { sleep } = require('./util');

/**
 * Busca músicas na API pública do Deezer. Não precisa de chave, app cadastrado,
 * OAuth nem conta Premium — é um endpoint público de catálogo.
 * Documentação: https://developers.deezer.com/api/search
 *
 * O Deezer limita ~50 requisições a cada 5 segundos e, ao estourar, responde
 * HTTP 200 com { error: { code: 4 } } — por isso o erro é lido do corpo e tentado de novo.
 */
async function fetchDeezer(url, tentativas = 3) {
  for (let i = 0; i < tentativas; i++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Falha na busca do Deezer: ${res.status} ${text}`);
    }

    const data = await res.json();
    if (data && data.error) {
      const quota = data.error.code === 4;
      if (quota && i < tentativas - 1) {
        await sleep(1200 * (i + 1));
        continue;
      }
      throw new Error(`Deezer: ${data.error.message || 'erro desconhecido'}`);
    }
    return data;
  }
  throw new Error('Deezer indisponível.');
}

async function searchTracks(query, limit = 12) {
  const url = new URL('https://api.deezer.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(Math.min(limit, 25)));

  const data = await fetchDeezer(url);
  const items = data.data || [];

  return items
    .filter((t) => !t.explicit_lyrics) // guardrail: nunca mostra conteúdo explícito pro aluno
    .map((t) => ({
      trackId: String(t.id),
      nome: t.title,
      artista: t.artist?.name || 'Artista desconhecido',
      capaUrl: t.album?.cover_medium || t.album?.cover || null,
      duracaoMs: (t.duration || 0) * 1000, // Deezer retorna duração em segundos
    }));
}

module.exports = { searchTracks };
