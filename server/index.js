import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = normalize(join(__dirname, ".."));
const publicDir = join(rootDir, "public");
const port = Number(process.env.PORT ?? 8787);

loadEnvFile();

const rooms = new Map();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"]
]);

function now() {
  return Date.now();
}

function loadEnvFile() {
  const envPath = join(rootDir, ".env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (!key || process.env[key] != null) continue;
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function createRoom(id) {
  return {
    id,
    seq: 0,
    hostId: null,
    participants: new Map(),
    clients: new Map(),
    player: {
      videoId: null,
      title: "",
      sourceUrl: "",
      channelTitle: "",
      thumbnail: "",
      durationLabel: "",
      addedBy: "",
      playing: false,
      position: 0,
      updatedAt: now()
    },
    queue: [],
    playlist: [],
    currentIndex: -1,
    history: [],
    createdAt: now()
  };
}

function getRoom(id) {
  const safeId = sanitizeRoomId(id);
  if (!rooms.has(safeId)) {
    rooms.set(safeId, createRoom(safeId));
  }
  return rooms.get(safeId);
}

function sanitizeRoomId(value) {
  const input = String(value || "").trim().toLowerCase();
  const cleaned = input.replace(/[^a-z0-9_-]/g, "").slice(0, 48);
  return cleaned || randomRoomId();
}

function randomRoomId() {
  return randomUUID().slice(0, 8);
}

function effectivePlayer(player) {
  if (!player.playing) return { ...player };
  const elapsed = Math.max(0, (now() - player.updatedAt) / 1000);
  return {
    ...player,
    position: player.position + elapsed
  };
}

function snapshot(room) {
  return {
    id: room.id,
    seq: room.seq,
    hostId: room.hostId,
    participants: [...room.participants.values()],
    player: effectivePlayer(room.player),
    queue: room.queue,
    playlist: room.playlist,
    currentIndex: room.currentIndex,
    history: room.playlist.slice(0, Math.max(0, room.currentIndex)),
    serverTime: now()
  };
}

function broadcast(room, event = "state") {
  const payload = `event: ${event}\ndata: ${JSON.stringify(snapshot(room))}\n\n`;
  for (const client of room.clients.values()) {
    client.write(payload);
  }
}

function touchRoom(room) {
  room.seq += 1;
}

function isPlaybackCommand(type) {
  return ["load", "play", "pause", "seek", "next", "jump", "heartbeat"].includes(type);
}

function requireHost(room, clientId, type) {
  if (!isPlaybackCommand(type)) return;
  if (!clientId || room.hostId !== clientId) {
    const err = new Error("Only the host can control playback.");
    err.status = 403;
    throw err;
  }
}

function promoteHost(room) {
  const nextHost = [...room.clients.keys()][0] || null;
  if (room.hostId !== nextHost) {
    room.hostId = nextHost;
    return true;
  }
  return false;
}

function setJson(res, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
}

function sendJson(res, data, status = 200) {
  setJson(res, status);
  res.end(JSON.stringify(data));
}

function authPassword() {
  return process.env.SYNC_ROOM_PASSWORD || process.env.SITE_PASSWORD || "";
}

function authToken(password) {
  return createHash("sha256").update(`dropin:${password}`).digest("hex");
}

function cookieValue(req, name) {
  const cookie = req.headers.cookie || "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function isAuthenticated(req) {
  const password = authPassword();
  if (!password) return true;
  return cookieValue(req, "dropin_auth") === authToken(password);
}

async function handleAuth(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    const required = Boolean(authPassword());
    sendJson(res, { required, authenticated: !required || isAuthenticated(req) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth") {
    const configured = authPassword();
    if (!configured) {
      sendJson(res, { ok: true });
      return true;
    }

    const body = await readBody(req);
    if (String(body.password || "") !== configured) {
      sendJson(res, { error: "Invalid passcode" }, 401);
      return true;
    }

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `dropin_auth=${authToken(configured)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function normalizeTrack(input) {
  const sourceUrl = String(input.sourceUrl || input.url || "").trim();
  const videoId = String(input.videoId || extractYouTubeId(sourceUrl) || "").trim();
  if (!videoId) {
    const err = new Error("A valid YouTube URL or video id is required.");
    err.status = 400;
    throw err;
  }
  return {
    id: randomUUID(),
    videoId,
    title: String(input.title || "YouTube video").trim().slice(0, 120),
    sourceUrl: sourceUrl || `https://www.youtube.com/watch?v=${videoId}`,
    channelTitle: String(input.channelTitle || "").trim().slice(0, 120),
    thumbnail: String(input.thumbnail || "").trim(),
    durationLabel: String(input.durationLabel || "").trim().slice(0, 24),
    addedBy: String(input.clientName || "Someone").trim().slice(0, 80),
    addedAt: now()
  };
}

function playerFromTrack(track, position = 0) {
  return {
    videoId: track.videoId,
    title: track.title,
    sourceUrl: track.sourceUrl,
    channelTitle: track.channelTitle,
    thumbnail: track.thumbnail,
    durationLabel: track.durationLabel,
    addedBy: track.addedBy,
    playing: true,
    position,
    updatedAt: now()
  };
}

function syncQueueFromPlaylist(room) {
  room.queue = room.currentIndex >= 0 ? room.playlist.slice(room.currentIndex + 1) : [...room.playlist];
}

function loadPlaylistIndex(room, index, position = 0) {
  if (index < 0 || index >= room.playlist.length) {
    const err = new Error("Track is no longer in the session list.");
    err.status = 404;
    throw err;
  }
  room.currentIndex = index;
  room.player = playerFromTrack(room.playlist[index], position);
  syncQueueFromPlaylist(room);
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function proxyThumbnailUrl(url) {
  return url ? `/api/thumb?url=${encodeURIComponent(url)}` : "";
}

async function searchYouTube(query) {
  const apiKey = process.env.YOUTUBE_API_KEY || "";
  if (!apiKey) {
    const err = new Error("YouTube search needs YOUTUBE_API_KEY. Paste a URL for now, or add the key and restart.");
    err.status = 501;
    throw err;
  }

  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    maxResults: "50",
    safeSearch: "moderate",
    key: apiKey
  });

  const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message || "YouTube search failed.";
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }

  const baseItems = (data.items || [])
    .filter((item) => item?.id?.videoId)
    .map((item) => {
      const snippet = item.snippet || {};
      return {
        videoId: item.id.videoId,
        title: decodeHtml(snippet.title || "YouTube video"),
        description: decodeHtml(snippet.description || ""),
        channelId: snippet.channelId || "",
        channelTitle: decodeHtml(snippet.channelTitle || ""),
        publishedAt: snippet.publishedAt || "",
        liveBroadcastContent: snippet.liveBroadcastContent || "none",
        thumbnails: snippet.thumbnails || {},
        thumbnail:
          proxyThumbnailUrl(
            snippet.thumbnails?.high?.url ||
            snippet.thumbnails?.medium?.url ||
            snippet.thumbnails?.default?.url ||
            ""
          ),
        sourceUrl: `https://www.youtube.com/watch?v=${item.id.videoId}`
      };
    });

  return {
    items: await enrichVideoResults(baseItems)
  };
}

async function enrichVideoResults(items) {
  const apiKey = process.env.YOUTUBE_API_KEY || "";
  const ids = items.map((item) => item.videoId).join(",");
  if (!apiKey || !ids) return items;

  const params = new URLSearchParams({
    part: "contentDetails,statistics",
    id: ids,
    key: apiKey
  });

  const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return items;

  const detailsById = new Map((data.items || []).map((item) => [item.id, item]));
  return items.map((item) => {
    const details = detailsById.get(item.videoId) || {};
    const duration = details.contentDetails?.duration || "";
    const statistics = details.statistics || {};
    return {
      ...item,
      duration,
      durationLabel: formatDuration(duration),
      viewCount: statistics.viewCount || "",
      likeCount: statistics.likeCount || "",
      commentCount: statistics.commentCount || ""
    };
  });
}

function formatDuration(duration) {
  const match = String(duration).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return "";
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function extractYouTubeId(value) {
  const input = String(value || "").trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;

  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      return url.pathname.split("/").filter(Boolean)[0] || "";
    }
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      if (url.searchParams.get("v")) return url.searchParams.get("v");
      const parts = url.pathname.split("/").filter(Boolean);
      const marker = parts.findIndex((part) => ["embed", "shorts", "live"].includes(part));
      if (marker >= 0 && parts[marker + 1]) return parts[marker + 1];
    }
  } catch {
    return "";
  }

  return "";
}

function updateParticipant(room, clientId, patch = {}) {
  const previous = room.participants.get(clientId) || {};
  const participant = {
    id: clientId,
    name: String(patch.name || previous.name || "Listener").slice(0, 48),
    color: String(patch.color || previous.color || "#7c9cff").slice(0, 24),
    joinedAt: previous.joinedAt || now(),
    lastSeenAt: now()
  };
  room.participants.set(clientId, participant);
  if (!room.hostId) room.hostId = clientId;
  return participant;
}

function applyCommand(room, command) {
  const clientId = String(command.clientId || "").slice(0, 80);
  if (clientId) {
    updateParticipant(room, clientId, {
      name: command.clientName,
      color: command.clientColor
    });
  }

  requireHost(room, clientId, command.type);

  switch (command.type) {
    case "join":
      return;

    case "load": {
      const track = normalizeTrack(command);
      room.playlist.push(track);
      loadPlaylistIndex(room, room.playlist.length - 1, Number(command.position || 0));
      touchRoom(room);
      return;
    }

    case "enqueue": {
      room.playlist.push(normalizeTrack(command));
      syncQueueFromPlaylist(room);
      touchRoom(room);
      return;
    }

    case "play": {
      const current = effectivePlayer(room.player);
      room.player = {
        ...room.player,
        playing: true,
        position: Number.isFinite(command.position) ? Number(command.position) : current.position,
        updatedAt: now()
      };
      touchRoom(room);
      return;
    }

    case "pause": {
      const current = effectivePlayer(room.player);
      room.player = {
        ...room.player,
        playing: false,
        position: Number.isFinite(command.position) ? Number(command.position) : current.position,
        updatedAt: now()
      };
      touchRoom(room);
      return;
    }

    case "seek": {
      room.player = {
        ...room.player,
        position: Math.max(0, Number(command.position || 0)),
        updatedAt: now()
      };
      touchRoom(room);
      return;
    }

    case "next": {
      const nextIndex = room.currentIndex + 1;
      if (nextIndex <= 0 || nextIndex >= room.playlist.length) {
        room.player = {
          ...room.player,
          playing: false,
          position: 0,
          updatedAt: now()
        };
        touchRoom(room);
        return;
      }
      loadPlaylistIndex(room, nextIndex, 0);
      touchRoom(room);
      return;
    }

    case "jump": {
      const index = Number(command.index);
      loadPlaylistIndex(room, index, 0);
      touchRoom(room);
      return;
    }

    case "heartbeat": {
      if (!room.player.videoId) return;
      const current = effectivePlayer(room.player);
      const position = Number(command.position);
      room.player = {
        ...room.player,
        playing: typeof command.playing === "boolean" ? command.playing : current.playing,
        position: Number.isFinite(position) ? Math.max(0, position) : current.position,
        updatedAt: now()
      };
      touchRoom(room);
      return;
    }

    case "remove": {
      const id = String(command.trackId || "");
      const index = room.playlist.findIndex((track) => track.id === id);
      if (index === -1 || index <= room.currentIndex) return;
      room.playlist.splice(index, 1);
      syncQueueFromPlaylist(room);
      touchRoom(room);
      return;
    }

    case "host": {
      if (clientId && room.participants.has(clientId)) {
        room.hostId = clientId;
        touchRoom(room);
      }
      return;
    }

    default: {
      const err = new Error(`Unknown command: ${command.type}`);
      err.status = 400;
      throw err;
    }
  }
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, { ok: true, uptime: process.uptime() });
    return true;
  }

  if (await handleAuth(req, res, url)) return true;
  if (!isAuthenticated(req)) {
    sendJson(res, { error: "Passcode required" }, 401);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/thumb") {
    const target = String(url.searchParams.get("url") || "");
    if (!/^https:\/\/(i\.ytimg\.com|img\.youtube\.com)\//.test(target)) {
      sendJson(res, { error: "Unsupported thumbnail host" }, 400);
      return true;
    }
    const upstream = await fetch(target);
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "image/jpeg",
      "Cache-Control": "public, max-age=86400"
    });
    const arrayBuffer = await upstream.arrayBuffer();
    res.end(Buffer.from(arrayBuffer));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/search") {
    const query = String(url.searchParams.get("q") || "").trim();
    if (query.length < 2) {
      sendJson(res, { items: [] });
      return true;
    }
    sendJson(res, await searchYouTube(query.slice(0, 120)));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const id = randomRoomId();
    getRoom(id);
    sendJson(res, { id });
    return true;
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/([^/]+))?$/);
  if (!roomMatch) return false;

  const room = getRoom(roomMatch[1]);
  const action = roomMatch[2] || "";

  if (req.method === "GET" && !action) {
    sendJson(res, snapshot(room));
    return true;
  }

  if (req.method === "GET" && action === "events") {
    const clientId = String(url.searchParams.get("clientId") || randomUUID()).slice(0, 80);
    updateParticipant(room, clientId, {
      name: url.searchParams.get("name"),
      color: url.searchParams.get("color")
    });

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(`event: hello\ndata: ${JSON.stringify(snapshot(room))}\n\n`);
    room.clients.set(clientId, res);
    broadcast(room, "presence");

    const keepAlive = setInterval(() => {
      res.write(`event: ping\ndata: ${JSON.stringify({ serverTime: now() })}\n\n`);
    }, 25000);

    req.on("close", () => {
      clearInterval(keepAlive);
      room.clients.delete(clientId);
      const participant = room.participants.get(clientId);
      if (participant) {
        participant.lastSeenAt = now();
      }
      const hostChanged = clientId === room.hostId && promoteHost(room);
      broadcast(room, hostChanged ? "host" : "presence");
    });
    return true;
  }

  if (req.method === "POST" && action === "commands") {
    const command = await readBody(req);
    applyCommand(room, command);
    broadcast(room, command.type === "heartbeat" ? "sync" : command.type || "state");
    sendJson(res, snapshot(room));
    return true;
  }

  return false;
}

function staticPath(pathname) {
  const cleanPath = decodeURIComponent(pathname).split("?")[0];
  const requested = cleanPath === "/" ? "/index.html" : cleanPath;
  const target = normalize(join(publicDir, requested));
  if (!target.startsWith(publicDir)) return null;
  return target;
}

async function handleStatic(req, res, url) {
  let target = staticPath(url.pathname);
  if (!target) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!existsSync(target)) {
    target = join(publicDir, "index.html");
  }

  const ext = extname(target);
  const contentType = mimeTypes.get(ext) || "application/octet-stream";
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups"
  };

  res.writeHead(200, headers);
  createReadStream(target).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (handled) return;
      sendJson(res, { error: "Not found" }, 404);
      return;
    }

    await handleStatic(req, res, url);
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, { error: error.message || "Server error" }, status);
  }
});

server.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
});
