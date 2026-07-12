// OpenCharacters server
//
// - Serves the static app (index.html, utils.js, etc.)
// - Persists chat data server-side via a tiny JSON API (/api/sync), so your chats
//   survive browser data clearing and are available from any browser that visits the site.
//
// Zero dependencies - just run:  node server.js
// Data is stored in ./server-data/chats.json
//
// Notes:
// - This is a single-user store (no accounts/auth). Put it behind auth (or at least
//   don't expose it publicly) if your chats are private.
// - The user's `misc` table (which contains the OpenAI API key and personal settings)
//   is intentionally NEVER sent to or stored on the server.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "server-data");
const DATA_FILE = path.join(DATA_DIR, "chats.json");
const MAX_BODY_BYTES = 200 * 1024 * 1024; // chats with data-URL avatars can be large

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

fs.mkdirSync(DATA_DIR, { recursive: true });

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    return { version: 0, savedAt: null, data: null };
  }
}

function writeStore(store) {
  // write to a temp file then rename, so a crash mid-write can't corrupt the store
  const tmpFile = DATA_FILE + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(store));
  fs.renameSync(tmpFile, DATA_FILE);
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/sync") {
    if (req.method === "GET") {
      const store = readStore();
      sendJson(res, 200, store);
      return true;
    }
    if (req.method === "PUT" || req.method === "POST") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        sendJson(res, 400, { error: "invalid JSON body: " + e.message });
        return true;
      }
      if (!body || typeof body.data !== "object" || body.data === null) {
        sendJson(res, 400, { error: "body must be {data: {tableName: rows[]}}" });
        return true;
      }
      // never persist the misc table, even if a client mistakenly sends it (it can contain the API key)
      delete body.data.misc;
      const prev = readStore();
      const store = {
        version: (prev.version || 0) + 1,
        savedAt: Date.now(),
        data: body.data,
      };
      writeStore(store);
      const totalRows = Object.values(store.data).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
      console.log(`[sync] saved version ${store.version} (${totalRows} rows) at ${new Date(store.savedAt).toISOString()}`);
      sendJson(res, 200, { ok: true, version: store.version, savedAt: store.savedAt });
      return true;
    }
    res.writeHead(405, { allow: "GET, PUT, POST" });
    res.end();
    return true;
  }
  return false;
}

function serveStatic(req, res, pathname) {
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(ROOT, path.normalize(pathname));
  // prevent path traversal, and don't serve the server's own data or git internals
  if (!filePath.startsWith(ROOT) || filePath.startsWith(DATA_DIR) || filePath.includes(path.sep + ".git")) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "content-length": stat.size,
      "cache-control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  try {
    if (pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, pathname);
      if (!handled) {
        res.writeHead(404);
        res.end("Unknown API endpoint");
      }
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    serveStatic(req, res, pathname);
  } catch (e) {
    console.error("Request error:", e);
    if (!res.headersSent) sendJson(res, 500, { error: "internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`OpenCharacters server running at http://localhost:${PORT}`);
  console.log(`Chat data is stored server-side in ${DATA_FILE}`);
});
