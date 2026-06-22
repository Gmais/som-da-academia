/**
 * Busca músicas na API pública do Deezer. Não precisa de chave, app cadastrado,
 * OAuth nem conta Premium — é um endpoint público de catálogo.
 * Documentação: https://developers.deezer.com/api/search
 */
async function searchTracks(query, limit = 12) {
  const url = new URL('https://api.deezer.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(Math.min(limit, 25)));

  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Falha na busca do Deezer: ${res.status} ${text}`);
  }

  const data = await res.json();
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