const { query } = require('./db');

const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

function getRedirectUri() {
  const base = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/api/spotify/callback`;
}

function getAuthorizeUrl(state) {
  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.set('client_id', process.env.SPOTIFY_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', getRedirectUri());
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

function basicAuthHeader() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

async function exchangeCodeForToken(code) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: getRedirectUri(),
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Falha ao trocar code por token: ${res.status} ${text}`);
  }

  const data = await res.json();
  await saveTokens(data.access_token, data.refresh_token, data.expires_in);
  return data;
}

async function saveTokens(accessToken, refreshToken, expiresInSeconds) {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  await query(
    `INSERT INTO spotify_auth (id, access_token, refresh_token, expires_at)
     VALUES (1, $1, COALESCE($2, (SELECT refresh_token FROM spotify_auth WHERE id = 1)), $3)
     ON CONFLICT (id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, spotify_auth.refresh_token),
       expires_at = EXCLUDED.expires_at`,
    [accessToken, refreshToken || null, expiresAt]
  );
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Falha ao renovar token: ${res.status} ${text}`);
  }

  const data = await res.json();
  await saveTokens(data.access_token, data.refresh_token, data.expires_in);
  return data.access_token;
}

/**
 * Retorna um access_token válido pra Authorization Code Flow (controle de
 * playback), renovando automaticamente se estiver perto de expirar.
 * Retorna null se a academia ainda não conectou a conta Spotify.
 */
async function getValidAccessToken() {
  const { rows } = await query('SELECT * FROM spotify_auth WHERE id = 1');
  const row = rows[0];
  if (!row || !row.refresh_token) return null;

  const fiveMinutes = 5 * 60 * 1000;
  if (row.access_token && Number(row.expires_at) > Date.now() + fiveMinutes) {
    return row.access_token;
  }

  return refreshAccessToken(row.refresh_token);
}

async function isConnected() {
  const { rows } = await query('SELECT refresh_token FROM spotify_auth WHERE id = 1');
  return Boolean(rows[0] && rows[0].refresh_token);
}

/**
 * Busca no catálogo do Spotify via Client Credentials (não precisa do
 * token do usuário) só pra resolver "nome + artista" -> URI exato do Spotify
 * no momento de tocar. limit <= 10, exigência das regras de Development Mode.
 */
let cachedAppToken = null;
let cachedAppTokenExpiresAt = 0;

async function getAppAccessToken() {
  if (cachedAppToken && Date.now() < cachedAppTokenExpiresAt - 5000) {
    return cachedAppToken;
  }
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Falha ao autenticar app no Spotify: ${res.status} ${text}`);
  }
  const data = await res.json();
  cachedAppToken = data.access_token;
  cachedAppTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedAppToken;
}

async function resolveTrackUri(nome, artista) {
  const token = await getAppAccessToken();
  const url = new URL('https://api.spotify.com/v1/search');
  url.searchParams.set('q', `${nome} ${artista}`);
  url.searchParams.set('type', 'track');
  url.searchParams.set('limit', '10');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Falha na busca do Spotify: ${res.status} ${text}`);
  }
  const data = await res.json();
  const track = data.tracks?.items?.[0];
  return track ? track.uri : null;
}

module.exports = {
  getAuthorizeUrl,
  exchangeCodeForToken,
  getValidAccessToken,
  isConnected,
  resolveTrackUri,
};
