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
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "server-data");
const DATA_FILE = path.join(DATA_DIR, "chats.json");
const MAX_BODY_BYTES = 200 * 1024 * 1024; // chats with data-URL avatars can be large

// The Perchance AI bridge (perchance-bridge.js) runs as a separate process. We proxy
// to it so the browser can reach it same-origin (avoids CORS/mixed-content issues when
// the app is served over a tunnel/https). See daemon.js for how it's kept alive.
const PERCHANCE_BRIDGE_PORT = Number(process.env.PERCHANCE_BRIDGE_PORT || 8080);
const PERCHANCE_BRIDGE_ORIGIN = process.env.PERCHANCE_BRIDGE_ORIGIN || `http://127.0.0.1:${PERCHANCE_BRIDGE_PORT}`;

// Safety limits for the "generate a character from a web page" fetch helper:
const FETCH_PAGE_MAX_BYTES = 5 * 1024 * 1024;
const FETCH_PAGE_TIMEOUT_MS = 20000;

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

  // ---- lightweight health/capability probe (used by the client to detect the server) ----
  if (pathname === "/api/health") {
    sendJson(res, 200, { ok: true, providers: ["pollinations"], proxy: true, sha256: true });
    return true;
  }

  // ---- SHA-256 helper for browsers on HTTP (crypto.subtle is unavailable outside secure contexts) ----
  if (pathname === "/api/sha256") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "POST only" });
      return true;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, 400, { error: "could not read body" });
      return true;
    }
    const hash = crypto.createHash("sha256").update(body).digest("hex");
    sendJson(res, 200, { hash });
    return true;
  }

  // ---- generic LLM proxy for free providers that block direct browser requests ----
  // The client points a model's endpointUrl at /api/llm-proxy?target=<encoded provider url>.
  // We forward the POST server-side (where there's no browser-origin Turnstile/CORS gate) and
  // stream the response straight back. Only an allowlist of known free providers is permitted.
  if (pathname === "/api/llm-proxy") {
    await proxyToLlmProvider(req, res);
    return true;
  }

  // ---- Perchance bridge proxy ----
  // /api/perchance/health                 -> bridge /health
  // /api/perchance/v1/chat/completions    -> bridge /v1/chat/completions (supports streaming)
  if (pathname === "/api/perchance/health" || pathname.startsWith("/api/perchance/")) {
    await proxyToPerchanceBridge(req, res, pathname);
    return true;
  }

  // ---- Fetch a web page server-side (for "generate a character from a web page") ----
  if (pathname === "/api/fetch-page") {
    await handleFetchPage(req, res);
    return true;
  }

  return false;
}

// Allowlist of free OpenAI-compatible providers we're willing to proxy to.
const LLM_PROXY_ALLOWED_HOSTS = new Set([
  "text.pollinations.ai",
]);

function proxyToLlmProvider(req, res) {
  return new Promise(async (resolve) => {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: { message: "POST only" } });
      return resolve();
    }
    let target;
    try {
      target = new URL(req.url, "http://localhost").searchParams.get("target");
    } catch (e) {
      sendJson(res, 400, { error: { message: "bad request" } });
      return resolve();
    }
    let parsed;
    try { parsed = new URL(target); } catch (e) {
      sendJson(res, 400, { error: { message: "invalid target url" } });
      return resolve();
    }
    if (!LLM_PROXY_ALLOWED_HOSTS.has(parsed.hostname)) {
      sendJson(res, 403, { error: { message: "target host not allowed: " + parsed.hostname } });
      return resolve();
    }
    let body;
    try { body = await readBody(req); } catch (e) {
      sendJson(res, 400, { error: { message: "could not read body" } });
      return resolve();
    }
    try {
      const upstream = await fetch(target, {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] || "application/json" },
        body,
      });
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      // stream the (possibly SSE) response straight back to the browser
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (e) {
      if (!res.headersSent) sendJson(res, 502, { error: { message: "upstream fetch failed: " + e.message } });
      else res.end();
    }
    resolve();
  });
}

function proxyToPerchanceBridge(req, res, pathname) {
  return new Promise((resolve) => {
    const targetPath = pathname.replace(/^\/api\/perchance/, "") || "/";
    let target;
    try {
      target = new URL(targetPath, PERCHANCE_BRIDGE_ORIGIN);
    } catch (e) {
      sendJson(res, 500, { error: "bad bridge origin" });
      return resolve();
    }
    const opts = {
      method: req.method,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      headers: { "content-type": req.headers["content-type"] || "application/json" },
    };
    const proxyReq = http.request(opts, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, {
        "content-type": proxyRes.headers["content-type"] || "application/json",
        "cache-control": "no-store",
      });
      proxyRes.pipe(res);
      proxyRes.on("end", resolve);
    });
    proxyReq.on("error", (e) => {
      // bridge is down / not running - report as unavailable (the client treats this as "no Perchance model")
      if (!res.headersSent) sendJson(res, 503, { ok: false, error: "perchance bridge unavailable: " + e.message });
      resolve();
    });
    // 4 minutes: perchance generations (esp. images, or with Turnstile retries) can be slow
    proxyReq.setTimeout(240000, () => proxyReq.destroy(new Error("bridge timeout")));
    req.pipe(proxyReq);
  });
}

async function handleFetchPage(req, res) {
  let targetUrl;
  try {
    targetUrl = new URL(req.url, "http://localhost").searchParams.get("url");
  } catch (e) {
    return sendJson(res, 400, { error: "bad request" });
  }
  if (!targetUrl) return sendJson(res, 400, { error: "url query param required" });

  let parsed;
  try { parsed = new URL(targetUrl); } catch (e) { return sendJson(res, 400, { error: "invalid url" }); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return sendJson(res, 400, { error: "only http/https urls are allowed" });
  }
  // basic SSRF guard: refuse obviously-internal hosts
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" || host === "0.0.0.0" || host.endsWith(".local") ||
    host.endsWith(".internal") || /^127\./.test(host) || /^10\./.test(host) ||
    /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
  ) {
    return sendJson(res, 400, { error: "refusing to fetch internal/private address" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_PAGE_TIMEOUT_MS);
  try {
    const r = await fetch(targetUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; OpenCharacters/1.0; +https://github.com/josephrocca/OpenCharacters)",
        accept: "text/html,application/xhtml+xml,text/plain,*/*",
      },
    });
    clearTimeout(timeout);
    const contentType = r.headers.get("content-type") || "";
    // read up to FETCH_PAGE_MAX_BYTES
    const reader = r.body.getReader();
    let received = 0;
    const parts = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > FETCH_PAGE_MAX_BYTES) { controller.abort(); break; }
      parts.push(Buffer.from(value));
    }
    const html = Buffer.concat(parts).toString("utf8");
    sendJson(res, 200, { ok: true, url: r.url, status: r.status, contentType, html });
  } catch (e) {
    clearTimeout(timeout);
    sendJson(res, 502, { ok: false, error: "fetch failed: " + e.message });
  }
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

server.listen(PORT, HOST, () => {
  console.log(`OpenCharacters server running at http://${HOST}:${PORT}`);
  console.log(`Chat data is stored server-side in ${DATA_FILE}`);
  console.log(`Perchance bridge proxied at /api/perchance/* -> ${PERCHANCE_BRIDGE_ORIGIN}`);
  console.log(`Web-page fetch helper available at /api/fetch-page?url=...`);
});
