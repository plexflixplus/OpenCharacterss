// Perchance AI text bridge
// ========================
//
// Perchance has no official public API. Its "ai-text-plugin" runs server-side on
// Perchance's own GPUs, funded by ads, and is gated behind a Cloudflare Turnstile
// "are you human?" check that is tied to a real browser session on a perchance.org
// generator page. There is no key you can request and no documented endpoint you
// can call directly.
//
// This bridge therefore does the only thing that actually works: it drives a real
// browser (via Playwright) that loads a genuine Perchance generator which imports
// the ai-text-plugin, lets that page pass Turnstile the normal way, and then calls
// the in-page `ai(...)` generation function on our behalf. It exposes the result as
// an OpenAI-compatible HTTP endpoint so the rest of OpenCharacters can treat
// Perchance like any other model provider.
//
// IMPORTANT REALITY CHECK:
//   Cloudflare Turnstile frequently refuses to issue a token from datacenter/cloud
//   IP ranges (you'll see "failed_verification" / Turnstile error 600010). In that
//   case generation will fail and the bridge reports itself as "not ready", and the
//   app simply won't show the Perchance model. Run this bridge from a residential
//   connection (e.g. your own machine, or a home server) for it to actually verify.
//
// The bridge is self-healing: it re-navigates the page on error and relaunches the
// browser if it crashes, and it re-verifies periodically. Combined with daemon.js
// (which restarts this process if it ever exits) it is kept alive at all times.
//
// Run directly:   node perchance-bridge.js
// Usually you'll instead run the supervisor:  node daemon.js
//
// Env vars:
//   PERCHANCE_BRIDGE_PORT   (default 8080)
//   PERCHANCE_GENERATOR     perchance generator slug that imports ai-text-plugin
//                           (default "ai-text-plugin-tester")
//   PERCHANCE_HEADLESS      "true" to force headless (default: headed; headed passes
//                           Turnstile more often - run under xvfb on a server)
//   PERCHANCE_MAX_CONCURRENCY  max simultaneous generations (default 2)

const http = require("http");

const PORT = Number(process.env.PERCHANCE_BRIDGE_PORT || 8080);
const GENERATOR = process.env.PERCHANCE_GENERATOR || "ai-text-plugin-tester";
const GENERATOR_URL = `https://perchance.org/${GENERATOR}`;
const HEADLESS = String(process.env.PERCHANCE_HEADLESS || "").toLowerCase() === "true";
const MAX_CONCURRENCY = Number(process.env.PERCHANCE_MAX_CONCURRENCY || 2);
const GEN_TIMEOUT_MS = 120000;

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (e) {
  console.error("[bridge] Playwright is not installed. Run: npm install playwright && npx playwright install chromium");
  process.exit(1);
}

// ---- browser session state -------------------------------------------------

let browser = null;
let context = null;
let page = null;
let genFrame = null;
let browserUp = false;
let lastVerifiedAt = 0; // timestamp of last successful generation
let starting = false;
let activeGenerations = 0;

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

async function findGeneratorFrame() {
  if (!page) return null;
  const frames = page.frames();
  return (
    frames.find((f) => /\.perchance\.org/.test(f.url()) && f.url().includes(GENERATOR)) || null
  );
}

async function startBrowser() {
  if (starting) return;
  starting = true;
  try {
    await stopBrowser();
    console.log(`[bridge] launching browser (headless=${HEADLESS}) -> ${GENERATOR_URL}`);
    browser = await chromium.launch({
      headless: HEADLESS,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
    });
    context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("close", () => { browserUp = false; });
    browser.on("disconnected", () => { browserUp = false; browser = null; });

    await page.goto(GENERATOR_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    // give the generator's sandboxed iframe time to boot and the plugin to init:
    await page.waitForTimeout(6000);
    genFrame = await findGeneratorFrame();
    if (!genFrame) throw new Error("could not find the generator frame after navigation");

    // kick off user verification (Turnstile) proactively via the plugin's preload path:
    await genFrame.evaluate(() => {
      try { window.root.ai({ preload: true }); } catch (e) {}
    }).catch(() => {});

    browserUp = true;
    console.log("[bridge] browser ready; generator frame located");
  } catch (e) {
    console.error("[bridge] startBrowser failed:", e.message);
    browserUp = false;
  } finally {
    starting = false;
  }
}

async function stopBrowser() {
  browserUp = false;
  genFrame = null;
  page = null;
  context = null;
  try { if (browser) await browser.close(); } catch (e) {}
  browser = null;
}

async function ensureReady() {
  if (!browserUp || !browser || !page || page.isClosed()) {
    await startBrowser();
  }
  if (browserUp) {
    genFrame = await findGeneratorFrame();
    if (!genFrame) {
      // the generator frame vanished (e.g. page reloaded) - try a fresh navigation
      try {
        await page.goto(GENERATOR_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(5000);
        genFrame = await findGeneratorFrame();
      } catch (e) {
        browserUp = false;
      }
    }
  }
  return browserUp && !!genFrame;
}

// ---- prompt conversion (OpenAI chat -> Perchance instruction/startWith) -----

function messagesToPerchancePrompt(messages) {
  const roleLabel = (m) => {
    if (m.role === "system") return "System";
    if (m.role === "assistant") return "Assistant";
    if (m.role === "user") return m.name || "User";
    return m.name || m.role || "User";
  };
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const convo = messages.filter((m) => m.role !== "system");

  let instruction = "";
  if (systemParts.length) instruction += systemParts.join("\n\n") + "\n\n";
  instruction += "Continue the following conversation. Write only the Assistant's next reply.\n\n";
  instruction += convo.map((m) => `${roleLabel(m)}: ${m.content}`).join("\n");
  instruction += "\nAssistant:";
  return instruction;
}

// ---- core generation via the in-page plugin --------------------------------
// onChunk(deltaText) is called for each incremental chunk. Resolves to full text.

async function generate({ messages, stop, onChunk, signal }) {
  const ready = await ensureReady();
  if (!ready) throw new Error("perchance bridge browser is not ready");

  const instruction = messagesToPerchancePrompt(messages);
  const stopSequences = Array.isArray(stop) ? stop.slice(0, 8) : stop ? [stop] : [];
  stopSequences.push("\nUser:", "\nSystem:");

  // Expose a callback the page can push streaming chunks to:
  const chunkFnName = "__ocBridgeChunk_" + Math.random().toString(36).slice(2);
  let full = "";
  await page.exposeFunction(chunkFnName, (delta) => {
    if (typeof delta !== "string") return;
    full += delta;
    if (onChunk) { try { onChunk(delta); } catch (e) {} }
  }).catch(() => {}); // may already be bound if reused - ignore

  const result = await Promise.race([
    genFrame.evaluate(
      async ({ instruction, stopSequences, chunkFnName }) => {
        let last = "";
        const res = await window.root.ai({
          instruction,
          stopSequences,
          onChunk: (d) => {
            const soFar = d.fullTextSoFar || "";
            const delta = soFar.slice(last.length);
            last = soFar;
            if (delta && window[chunkFnName]) window[chunkFnName](delta);
          },
        });
        return { text: res.generatedText ?? res.text ?? "", stopReason: res.stopReason };
      },
      { instruction, stopSequences, chunkFnName }
    ),
    new Promise((_, rej) => setTimeout(() => rej(new Error("generation timed out")), GEN_TIMEOUT_MS)),
  ]);

  const text = (result && result.text) || full || "";
  if (!text.trim()) throw new Error("perchance returned no text (likely Turnstile/verification failure)");
  lastVerifiedAt = Date.now();
  return text.trim();
}

// ---- HTTP server (OpenAI-compatible) ---------------------------------------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleChatCompletion(req, res) {
  if (activeGenerations >= MAX_CONCURRENCY) {
    return sendJson(res, 429, { error: { message: "bridge busy - too many concurrent generations", type: "rate_limit" } });
  }
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (e) { return sendJson(res, 400, { error: { message: "invalid JSON body" } }); }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return sendJson(res, 400, { error: { message: "messages[] required" } });
  const wantStream = body.stream === true;
  const id = "chatcmpl-perchance-" + Math.random().toString(36).slice(2, 12);
  const created = Math.floor(Date.now() / 1000);

  activeGenerations++;
  try {
    if (wantStream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      const send = (delta, finish) => {
        const chunk = { id, object: "chat.completion.chunk", created, model: "perchance",
          choices: [{ index: 0, delta: finish ? {} : { content: delta }, finish_reason: finish || null }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };
      // prime a role delta so OpenAI-style parsers are happy:
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "perchance", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
      try {
        await generate({ messages, stop: body.stop, onChunk: (d) => send(d, null) });
        send("", "stop");
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (e) {
        // stream already started - emit an error chunk then close
        res.write(`data: ${JSON.stringify({ error: { message: String(e.message) } })}\n\n`);
        res.end();
      }
    } else {
      const text = await generate({ messages, stop: body.stop });
      sendJson(res, 200, {
        id, object: "chat.completion", created, model: "perchance",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  } catch (e) {
    if (!res.headersSent) sendJson(res, 503, { error: { message: String(e.message), type: "bridge_unavailable" } });
  } finally {
    activeGenerations--;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    });
    return res.end();
  }
  if (url.pathname === "/health") {
    const verifiedRecently = lastVerifiedAt > 0 && Date.now() - lastVerifiedAt < 30 * 60 * 1000;
    return sendJson(res, 200, {
      ok: browserUp,
      browserUp,
      // "ready" means the bridge has actually produced text at least once (i.e. Cloudflare
      // verification succeeded). The client only exposes the Perchance model when this is true,
      // so users on IPs where Turnstile refuses to verify don't get a broken model option.
      ready: browserUp && lastVerifiedAt > 0,
      verifiedRecently,
      lastVerifiedAt,
      generator: GENERATOR,
      activeGenerations,
    });
  }
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    return handleChatCompletion(req, res);
  }
  sendJson(res, 404, { error: { message: "not found" } });
});

server.listen(PORT, () => {
  console.log(`[bridge] Perchance bridge listening on http://localhost:${PORT}`);
  console.log(`[bridge]   generator: ${GENERATOR_URL}`);
  console.log(`[bridge]   health:    http://localhost:${PORT}/health`);
});

// ---- supervision within the process ----------------------------------------

(async function boot() {
  await startBrowser();
  // warm-up verification attempt (best-effort):
  try {
    await generate({ messages: [{ role: "user", content: "Say hi in one word." }] });
    console.log("[bridge] warm-up generation succeeded - Turnstile verification OK");
  } catch (e) {
    console.warn("[bridge] warm-up generation failed:", e.message);
    console.warn("[bridge] (this is expected on datacenter IPs where Cloudflare Turnstile refuses to verify)");
  }
})();

// keep the browser session healthy: re-verify / relaunch if it goes stale
setInterval(async () => {
  if (activeGenerations > 0) return;
  try {
    if (!browserUp || !browser || !page || page.isClosed()) {
      await startBrowser();
    } else if (Date.now() - lastVerifiedAt > 5 * 60 * 1000) {
      // periodic keepalive generation so verification stays warm
      await generate({ messages: [{ role: "user", content: "ping" }] }).catch(() => {});
    }
  } catch (e) {
    console.error("[bridge] health loop error:", e.message);
  }
}, 60 * 1000);

process.on("SIGTERM", async () => { await stopBrowser(); process.exit(0); });
process.on("SIGINT", async () => { await stopBrowser(); process.exit(0); });
