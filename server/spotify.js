let cachedToken = null;
let cachedTokenExpiresAt = 0;

/**
 * Pega (ou reusa) um token de acesso via Client Credentials Flow.
 * Esse fluxo só serve para BUSCA (endpoints públicos do catálogo).
 * Controlar playback de verdade (tocar/pausar num dispositivo) exige
 * Authorization Code Flow + conta Spotify Premium — fica para uma fase futura.
 */
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 5000) {
    return cachedToken;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET não configurados no .env. ' +
        'Crie um app gratuito em https://developer.spotify.com/dashboard'
    );
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Falha ao autenticar no Spotify: ${res.status} ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + data.expires_in * 1000;
  return cachedToken;
}

/**
 * Busca músicas no catálogo do Spotify e já filtra faixas marcadas como
 * "explicit" — guardrail automático para evitar conteúdo impróprio na fila.
 */
async function searchTracks(query, limit = 12) {
  const token = await getAccessToken();

  const url = new URL('https://api.spotify.com/v1/search');
  url.searchParams.set('q', query);
  url.searchParams.set('type', 'track');
  url.searchParams.set('limit', String(Math.min(limit, 50)));

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Falha na busca do Spotify: ${res.status} ${text}`);
  }

  const data = await res.json();
  const items = (data.tracks && data.tracks.items) || [];

  return items
    .filter((t) => !t.explicit) // guardrail: nunca mostra conteúdo explícito pro aluno
    .map((t) => ({
      spotifyTrackId: t.id,
      nome: t.name,
      artista: t.artists.map((a) => a.name).join(', '),
      capaUrl: t.album.images?.[2]?.url || t.album.images?.[0]?.url || null,
      duracaoMs: t.duration_ms,
    }));
}

module.exports = { searchTracks };
