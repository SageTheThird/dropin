import spotify from "spotify-url-info";

const MAX_SPOTIFY_TRACKS = 100;

// In-memory token cache: { access_token, expiresAt }
let cachedToken = null;

// Public client token cache (no credentials needed)
let cachedPublicToken = null;
let cachedPublicTokenExpiry = 0;

const spotifyFetch = async (url, opts = {}) =>
  fetch(url, {
    ...opts,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ...opts.headers,
    },
  });

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
 * Fetch Spotify public access token — no credentials needed.
 * Uses open.spotify.com/get_access_token endpoint.
 * Caches in-memory; re-fetches if expired (60s buffer).
 */
export async function getSpotifyClientToken() {
  const now = Date.now();
  if (cachedPublicToken && now < cachedPublicTokenExpiry - 60000) {
    return cachedPublicToken;
  }

  const res = await spotifyFetch("https://open.spotify.com/get_access_token");
  if (!res.ok) {
    throw new Error(`Spotify public token fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  cachedPublicToken = data.accessToken;
  cachedPublicTokenExpiry = data.accessTokenExpirationTimestampMs;
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
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&offset=0`;

  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Spotify tracks fetch failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();

    for (const item of data.items) {
      if (!item.track) continue;
      allTracks.push({
        title: item.track.name,
        artist: item.track.artists.map(a => a.name).join(", "),
        durationMs: item.track.duration_ms,
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

  // Paginate through all tracks
  const allTracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&offset=0`;

  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Spotify tracks fetch failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();

    for (const item of data.items) {
      if (!item.track) continue; // skip null/deleted tracks
      allTracks.push({
        title: item.track.name,
        artist: item.track.artists.map(a => a.name).join(", "),
        durationMs: item.track.duration_ms,
      });
    }

    url = data.next; // null when no more pages
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
