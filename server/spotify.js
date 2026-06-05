import crypto from "node:crypto";
import spotify from "spotify-url-info";

const MAX_SPOTIFY_TRACKS = 100;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// In-memory token cache: { access_token, expiresAt }
let cachedToken = null;

// Public client token cache (no credentials needed)
let cachedPublicToken = null;
let cachedPublicTokenExpiry = 0;

// Cached TOTP secret extracted from the web-player bundle: { bytes:number[], version:number }
let cachedSecret = null;

// Hardcoded fallback secrets (from binimum/latest_secret.json, 2026). Used only if
// bundle extraction fails. Highest version wins. These rotate ~monthly; bundle
// extraction is preferred and tried first.
const FALLBACK_SECRETS = [
  { version: 61, bytes: [44, 55, 47, 42, 70, 40, 34, 114, 76, 74, 50, 111, 120, 97, 75, 76, 94, 102, 43, 69, 49, 120, 118, 80, 64, 78] },
  { version: 60, bytes: [79, 109, 69, 123, 90, 65, 46, 74, 94, 34, 58, 48, 70, 71, 92, 85, 122, 63, 91, 64, 87, 87] },
  { version: 59, bytes: [123, 105, 79, 70, 110, 59, 52, 125, 60, 49, 80, 70, 89, 75, 80, 86, 63, 53, 123, 37, 117, 49, 52, 93, 77, 62, 47, 86, 48, 104, 68, 72] },
];

const spotifyFetch = async (url, opts = {}) =>
  fetch(url, {
    ...opts,
    headers: {
      "User-Agent": BROWSER_UA,
      ...opts.headers,
    },
  });

/**
 * XOR each secret byte with (index % 33 + 9) — Spotify's web-player `tt` transform.
 * Returns the TOTP HMAC key derived from the transformed digits.
 */
function deriveTotpKey(secretBytes) {
  const xored = secretBytes.map((b, i) => b ^ ((i % 33) + 9));
  const joined = xored.join("");
  const hex = Buffer.from(joined, "utf-8").toString("hex");
  return Buffer.from(hex, "hex");
}

/**
 * Generate a 6-digit TOTP (SHA1, 30s period) for the given unix-seconds timestamp.
 */
function generateTOTP(secretBytes, timestampSec) {
  const key = deriveTotpKey(secretBytes);
  const counter = Math.floor(timestampSec / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

/**
 * Extract the TOTP secret from Spotify's web-player JS bundle.
 * Fetches open.spotify.com → finds bundle URL → parses {secret:[...],version:N} array.
 * Picks the highest version. Falls back to hardcoded secrets on any failure.
 * Result cached in-memory for the process lifetime.
 */
async function getTotpSecret() {
  if (cachedSecret) return cachedSecret;

  try {
    const pageRes = await spotifyFetch("https://open.spotify.com/");
    const html = await pageRes.text();
    const bundleMatch = html.match(/(https:\/\/[^"']+\/web-player\.[0-9a-f]+\.js)/);
    if (!bundleMatch) throw new Error("bundle URL not found");

    const bundleRes = await spotifyFetch(bundleMatch[1]);
    const bundle = await bundleRes.text();

    // Secrets appear as: {secret:[12,34,...],version:61} or {secret:"...",version:61}
    const entries = [];
    const re = /\{secret:(\[[0-9,\s]+\]|["'][^"']+["']),\s*version:(\d+)\}/g;
    let m;
    while ((m = re.exec(bundle)) !== null) {
      const rawSecret = m[1];
      const version = parseInt(m[2], 10);
      let bytes;
      if (rawSecret.startsWith("[")) {
        bytes = JSON.parse(rawSecret);
      } else {
        const str = rawSecret.slice(1, -1);
        bytes = Array.from(str, (c) => c.charCodeAt(0));
      }
      entries.push({ version, bytes });
    }

    if (!entries.length) throw new Error("no secrets in bundle");
    entries.sort((a, b) => b.version - a.version);
    cachedSecret = entries[0];
    return cachedSecret;
  } catch (err) {
    console.warn("Spotify secret bundle extraction failed, using fallback:", err.message);
    cachedSecret = FALLBACK_SECRETS[0];
    return cachedSecret;
  }
}

/**
 * Fetch Spotify access token via client credentials flow.
 * Caches token in-memory; re-fetches after expiry (with 60s buffer).
 */
export async function getSpotifyAccessToken(clientId, clientSecret) {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.access_token;
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    throw new Error(`Spotify token fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  cachedToken = {
    access_token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 60000, // 60s buffer
  };

  return cachedToken.access_token;
}

/**
 * Fetch an anonymous Spotify web-player token — no credentials needed.
 * The legacy get_access_token endpoint is dead; Spotify now requires a TOTP
 * challenge on /api/token. We mint the TOTP from the web-player secret, sync to
 * Spotify server time, and request the token. Caches in-memory (60s buffer).
 */
export async function getSpotifyClientToken() {
  const now = Date.now();
  if (cachedPublicToken && now < cachedPublicTokenExpiry - 60000) {
    return cachedPublicToken;
  }

  const secret = await getTotpSecret();

  // Sync to Spotify server time so the TOTP matches their counter window.
  let serverTimeSec;
  try {
    const timeRes = await spotifyFetch("https://open.spotify.com/api/server-time");
    const timeData = await timeRes.json();
    serverTimeSec = timeData.serverTime;
  } catch {
    serverTimeSec = Math.floor(Date.now() / 1000);
  }
  if (!Number.isFinite(serverTimeSec)) {
    serverTimeSec = Math.floor(Date.now() / 1000);
  }

  const totp = generateTOTP(secret.bytes, serverTimeSec);
  const params = new URLSearchParams({
    reason: "init",
    productType: "web_player",
    totp,
    totpServer: totp,
    totpVer: String(secret.version),
  });

  const res = await spotifyFetch(`https://open.spotify.com/api/token?${params}`, {
    headers: {
      Accept: "*/*",
      Origin: "https://open.spotify.com",
      Referer: "https://open.spotify.com/",
    },
  });

  if (!res.ok) {
    throw new Error(`Spotify public token fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  if (!data.accessToken) {
    throw new Error(`Spotify public token response missing accessToken: ${JSON.stringify(data).slice(0, 200)}`);
  }

  cachedPublicToken = data.accessToken;
  cachedPublicTokenExpiry =
    data.accessTokenExpirationTimestampMs || Date.now() + 3600 * 1000;
  return cachedPublicToken;
}

/**
 * Fetch all tracks from a Spotify playlist via public client token (no credentials).
 * Uses standard Spotify Web API with pagination.
 */
export async function fetchSpotifyTracksViaPathfinder(playlistId, token) {
  const headers = { Authorization: `Bearer ${token}` };

  const metaRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, { headers });
  if (!metaRes.ok) {
    throw new Error(`Spotify playlist metadata failed: ${metaRes.status} ${metaRes.statusText}`);
  }
  const meta = await metaRes.json();

  const allTracks = [];
  // March 2026: /tracks was renamed to /items; item.track became item.item.
  // Fall back to the old shape if Spotify serves it during migration.
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100&offset=0`;

  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Spotify tracks fetch failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();

    for (const item of data.items || []) {
      const track = item.item || item.track;
      if (!track) continue;
      allTracks.push({
        title: track.name,
        artist: (track.artists || []).map((a) => a.name).join(", "),
        durationMs: track.duration_ms,
      });
    }

    url = data.next;
  }

  return {
    name: meta.name || "Spotify Playlist",
    cover: meta.images?.[0]?.url || "",
    tracks: allTracks,
  };
}

/**
 * Fetch all tracks from a Spotify playlist via official API (paginated).
 * Also fetches playlist metadata (name, cover).
 */
export async function fetchSpotifyTracksWithAPI(playlistId, accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };

  // Fetch playlist metadata
  const metaRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, { headers });
  if (!metaRes.ok) {
    throw new Error(`Spotify playlist metadata fetch failed: ${metaRes.status} ${metaRes.statusText}`);
  }
  const meta = await metaRes.json();

  const allTracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100&offset=0`;

  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Spotify tracks fetch failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();

    for (const item of data.items || []) {
      const track = item.item || item.track;
      if (!track) continue;
      allTracks.push({
        title: track.name,
        artist: (track.artists || []).map((a) => a.name).join(", "),
        durationMs: track.duration_ms,
      });
    }

    url = data.next;
  }

  return {
    name: meta.name || "Spotify Playlist",
    cover: meta.images?.[0]?.url || "",
    tracks: allTracks,
  };
}

/**
 * Extract Spotify playlist ID from URL.
 * Handles: open.spotify.com/playlist/{id}, spotify:playlist:{id}, embed URLs
 */
function extractPlaylistId(url) {
  const match = url.match(/playlist[/:]([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Fetch Spotify playlist/album/track metadata and track list.
 * Auto-detects: if SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET env vars set → use official API (full playlist, paginated).
 * Otherwise → fall back to embed scrape (100-track cap).
 *
 * Returns { name, cover, tracks: [{ title, artist, durationMs }] }.
 */
export async function fetchSpotifyTracks(url) {
  const playlistId = extractPlaylistId(url);

  // Try public client token first (no credentials needed)
  if (playlistId) {
    try {
      const publicToken = await getSpotifyClientToken();
      return await fetchSpotifyTracksViaPathfinder(playlistId, publicToken);
    } catch (publicErr) {
      console.warn("Spotify public token path failed, trying alternatives:", publicErr.message);
    }
  }

  // Try credential-based API if env vars set
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (playlistId && clientId && clientSecret) {
    try {
      const token = await getSpotifyAccessToken(clientId, clientSecret);
      return await fetchSpotifyTracksWithAPI(playlistId, token);
    } catch (apiErr) {
      console.error("Spotify credential API failed, falling back to embed scrape:", apiErr.message);
    }
  }

  // Fallback: embed scrape (100-track cap)
  const { getTracks, getData } = spotify(spotifyFetch);

  let dataResult, tracksResult;
  try {
    [dataResult, tracksResult] = await Promise.all([
      getData(url).catch(() => null),
      getTracks(url)
    ]);
  } catch (cause) {
    const err = new Error("Could not load that Spotify playlist (private, removed, or region-locked).");
    err.status = 404;
    if (cause?.statusCode === 429 || cause?.message?.includes?.("429")) {
      err.message = "Spotify is rate-limiting us. Wait a moment and try again.";
      err.status = 502;
    }
    err.cause = cause;
    throw err;
  }

  const name = dataResult?.name || "";
  const coverArt = dataResult?.cover || dataResult?.coverArt || dataResult?.images?.[0]?.url || "";

  const rawTracks = Array.isArray(tracksResult) ? tracksResult : [];

  const tracks = rawTracks
    .slice(0, MAX_SPOTIFY_TRACKS)
    .map((t) => ({
      title: t.name || t.title || "",
      artist: t.artist || t.subtitle || "",
      durationMs: t.duration || 0
    }))
    .filter((t) => t.title);

  return { name: name || "Spotify Playlist", cover: coverArt, tracks };
}
