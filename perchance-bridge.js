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
//   PERCHANCE_MAX_CONCURRENCY  max simultaneous text generations (default 2)
//   PERCHANCE_MAX_IMAGE_CONCURRENCY  max simultaneous image generations (default 1)
//   PERCHANCE_GEN_TIMEOUT_MS  text generation timeout (default 4 min)
//   PERCHANCE_KEEPALIVE_MS  ms between light session keepalives (default 4 min)
//   PERCHANCE_PRELOAD_IMAGE "false" to skip preloading the image generator at boot

const http = require("http");

const PORT = Number(process.env.PERCHANCE_BRIDGE_PORT || 8080);
const GENERATOR = process.env.PERCHANCE_GENERATOR || "ai-text-plugin-tester";
const GENERATOR_URL = `https://perchance.org/${GENERATOR}`;
const IMAGE_GENERATOR = process.env.PERCHANCE_IMAGE_GENERATOR || "ai-character-chat";
const IMAGE_GENERATOR_URL = `https://perchance.org/${IMAGE_GENERATOR}`;
const HEADLESS = String(process.env.PERCHANCE_HEADLESS || "").toLowerCase() === "true";
const MAX_TEXT_CONCURRENCY = Number(process.env.PERCHANCE_MAX_TEXT_CONCURRENCY || process.env.PERCHANCE_MAX_CONCURRENCY || 2);
const MAX_IMAGE_CONCURRENCY = Number(process.env.PERCHANCE_MAX_IMAGE_CONCURRENCY || 1);
const KEEPALIVE_MS = Number(process.env.PERCHANCE_KEEPALIVE_MS || 4 * 60 * 1000);
const PRELOAD_IMAGE = String(process.env.PERCHANCE_PRELOAD_IMAGE || "true").toLowerCase() !== "false";
const GEN_TIMEOUT_MS = Number(process.env.PERCHANCE_GEN_TIMEOUT_MS || 240000);
const IMG_TIMEOUT_MS = 180000;
const CHUNK_FN_NAME = "__ocBridgeChunk";

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
let lastVerifiedAt = 0;
let lastKeepaliveAt = 0;
let starting = false;
let textRecovering = false;
let activeTextGenerations = 0;
let activeImageGenerations = 0;
let healthBusy = false;
let chunkHandlerBound = false;

// Web-page scraping uses its own browser so fandom/wiki loads can't crash Perchance.
let scrapeBrowser = null;
let scrapeContext = null;

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

function handleTextBrowserLost(reason) {
  console.warn(`[bridge] text browser session lost (${reason})`);
  browserUp = false;
  genFrame = null;
  page = null;
  context = null;
  chunkHandlerBound = false;
  browser = null;
}

function scheduleTextRecovery(reason) {
  if (textRecovering || starting) return;
  setImmediate(async () => {
    if (await recoverTextPage(reason)) return;
    if (browser && browser.isConnected()) {
      await startBrowser("recovery-hard-restart");
    } else {
      handleTextBrowserLost(reason);
      await startBrowser("recovery-after-disconnect");
    }
  });
}

function bindTextPageHandlers(p) {
  p.on("close", () => {
    console.warn("[bridge] text page closed");
    browserUp = false;
    scheduleTextRecovery("page-close");
  });
}

async function recoverTextPage(reason) {
  if (textRecovering || starting) return false;
  if (!browser || !browser.isConnected() || !context) return false;
  textRecovering = true;
  try {
    console.log(`[bridge] recovering text page (${reason})`);
    chunkHandlerBound = false;
    genFrame = null;
    page = null;
    const p = await context.newPage();
    p.__ocBridgeOnChunk = null;
    bindTextPageHandlers(p);
    await p.goto(GENERATOR_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForCondition(async () => {
      page = p;
      return !!(await findGeneratorFrame());
    }, { timeoutMs: 20000, intervalMs: 300, label: "text generator frame" });
    page = p;
    genFrame = await findGeneratorFrame();
    if (!genFrame) throw new Error("generator frame not found after recovery");
    await bindChunkHandler();
    await genFrame.evaluate(() => {
      try { window.root.ai({ preload: true }); } catch (e) {}
    }).catch(() => {});
    browserUp = true;
    lastKeepaliveAt = Date.now();
    console.log("[bridge] text page recovered");
    return true;
  } catch (e) {
    console.warn("[bridge] text page recovery failed:", e.message);
    return false;
  } finally {
    textRecovering = false;
  }
}

function handleImageBrowserLost(reason) {
  console.warn(`[bridge] image browser session lost (${reason})`);
  imagePage = null;
  imageFrame = null;
  imageContext = null;
  imageBrowser = null;
  imageBrowserUp = false;
}

async function stopImageBrowser() {
  const b = imageBrowser;
  handleImageBrowserLost("stop-image-browser");
  try { if (b) await b.close(); } catch (e) {}
}

async function ensureImageBrowser() {
  if (imageBrowser && imageBrowser.isConnected() && imageContext) return imageContext;
  await stopImageBrowser();
  console.log(`[bridge] launching image browser (headless=${HEADLESS}) -> ${IMAGE_GENERATOR_URL}`);
  imageBrowser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-gpu",
      "--enable-unsafe-swiftshader",
    ],
  });
  imageContext = await imageBrowser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 900 } });
  await configureContext(imageContext);
  imageBrowser.on("disconnected", () => {
    console.warn("[bridge] image browser disconnected");
    handleImageBrowserLost("image-browser-disconnected");
  });
  imageBrowserUp = true;
  return imageContext;
}

async function stopScrapeBrowser() {
  scrapeContext = null;
  try { if (scrapeBrowser) await scrapeBrowser.close(); } catch (e) {}
  scrapeBrowser = null;
}

async function ensureScrapeBrowser() {
  if (scrapeBrowser && scrapeBrowser.isConnected()) return scrapeContext;
  await stopScrapeBrowser();
  scrapeBrowser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  });
  scrapeContext = await scrapeBrowser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
  });
  return scrapeContext;
}

let imageQueue = Promise.resolve();
function enqueueImageTask(task) {
  const run = imageQueue.then(task, task);
  imageQueue = run.catch(() => {});
  return run;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForCondition(fn, { timeoutMs = 30000, intervalMs = 250, label = "condition" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch (e) {}
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function shouldAllowRequest(url, resourceType) {
  if (/challenges\.cloudflare\.com|turnstile|cloudflare\.com\/cdn-cgi/.test(url)) return true;
  if (resourceType === "document" || resourceType === "script" || resourceType === "xhr" || resourceType === "fetch") return true;
  if (resourceType === "stylesheet") return /perchance\.org/.test(url);
  return false;
}

async function configureContext(ctx) {
  await ctx.route("**/*", (route) => {
    const req = route.request();
    const url = req.url();
    const type = req.resourceType();
    if (shouldAllowRequest(url, type)) return route.continue();
    return route.abort();
  });
}

async function bindChunkHandler() {
  if (!page || chunkHandlerBound) return;
  await page.exposeFunction(CHUNK_FN_NAME, (delta) => {
    if (typeof delta !== "string" || !page.__ocBridgeOnChunk) return;
    try { page.__ocBridgeOnChunk(delta); } catch (e) {}
  }).catch(() => {});
  chunkHandlerBound = true;
}

async function findGeneratorFrame() {
  if (!page) return null;
  const frames = page.frames();
  return (
    frames.find((f) => /\.perchance\.org/.test(f.url()) && f.url().includes(GENERATOR)) || null
  );
}

async function refreshTextFrame({ reason = "unknown" } = {}) {
  if (!page || page.isClosed()) return false;
  genFrame = await findGeneratorFrame();
  if (genFrame) return true;
  console.warn(`[bridge] text generator frame missing (${reason}) - reloading page`);
  try {
    await page.goto(GENERATOR_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForCondition(async () => !!(await findGeneratorFrame()), {
      timeoutMs: 20000,
      intervalMs: 300,
      label: "text generator frame",
    });
    genFrame = await findGeneratorFrame();
    if (genFrame) {
      await genFrame.evaluate(() => {
        try { window.root.ai({ preload: true }); } catch (e) {}
      }).catch(() => {});
      return true;
    }
  } catch (e) {
    console.warn("[bridge] soft text-frame recovery failed:", e.message);
  }
  return false;
}

async function startBrowser(reason = "startup") {
  if (starting) return;
  starting = true;
  try {
    await stopBrowser();
    console.log(`[bridge] launching browser (headless=${HEADLESS}, reason=${reason}) -> ${GENERATOR_URL}`);
    browser = await chromium.launch({
      headless: HEADLESS,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-gpu",
        "--enable-unsafe-swiftshader",
      ],
    });
    context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 900 } });
    await configureContext(context);
    page = await context.newPage();
    page.__ocBridgeOnChunk = null;
    bindTextPageHandlers(page);
    browser.on("disconnected", () => {
      console.warn("[bridge] browser disconnected");
      handleTextBrowserLost("browser-disconnected");
      scheduleTextRecovery("browser-disconnected");
    });

    await page.goto(GENERATOR_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForCondition(async () => !!(await findGeneratorFrame()), {
      timeoutMs: 20000,
      intervalMs: 300,
      label: "text generator frame",
    });
    genFrame = await findGeneratorFrame();
    if (!genFrame) throw new Error("could not find the generator frame after navigation");

    await bindChunkHandler();
    await genFrame.evaluate(() => {
      try { window.root.ai({ preload: true }); } catch (e) {}
    }).catch(() => {});

    browserUp = true;
    lastKeepaliveAt = Date.now();
    console.log("[bridge] browser ready; generator frame located");
  } catch (e) {
    console.error("[bridge] startBrowser failed:", e.message);
    browserUp = false;
  } finally {
    starting = false;
  }
}

async function stopBrowser() {
  const b = browser;
  handleTextBrowserLost("stop-browser");
  try { if (b) await b.close(); } catch (e) {}
}

// ---- image generation (separate browser so GPU-heavy renders can't crash text) -

let imageBrowser = null;
let imageContext = null;
let imageBrowserUp = false;
let imagePage = null;
let imageFrame = null;
let imagePageStarting = false;
let lastImageVerifiedAt = 0;

async function findImageFrame() {
  if (!imagePage) return null;
  const frames = imagePage.frames();
  return (
    frames.find((f) => /\.perchance\.org/.test(f.url()) && f.url().includes(IMAGE_GENERATOR)) || null
  );
}

async function ensureImageReady() {
  const ctx = await ensureImageBrowser();
  if (!ctx) return false;
  if (imagePageStarting) {
    for (let i = 0; i < 60 && imagePageStarting; i++) await sleep(500);
  }
  if (!imagePage || imagePage.isClosed() || !(await findImageFrame())) {
    imagePageStarting = true;
    try {
      if (imagePage && !imagePage.isClosed()) { try { await imagePage.close(); } catch (e) {} }
      console.log(`[bridge] loading image generator page -> ${IMAGE_GENERATOR_URL}`);
      imagePage = await ctx.newPage();
      await imagePage.goto(IMAGE_GENERATOR_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      await waitForCondition(async () => {
        imageFrame = await findImageFrame();
        if (!imageFrame) return false;
        return imageFrame.evaluate(() => !!(window.root && window.root.textToImagePlugin)).catch(() => false);
      }, { timeoutMs: 25000, intervalMs: 400, label: "image generator plugin" });
    } catch (e) {
      console.error("[bridge] image generator page failed to load:", e.message);
    } finally {
      imagePageStarting = false;
    }
  }
  imageFrame = await findImageFrame();
  return !!imageFrame;
}

async function generateImageOnce(options) {
  const ok = await ensureImageReady();
  if (!ok) throw new Error("perchance image generator is not ready");

  try { await imagePage.bringToFront(); } catch (e) {}
  console.log(`[bridge] image generation started: ${String(options.prompt).slice(0, 80)}...`);

  const result = await Promise.race([
    imageFrame.evaluate(
      async (opts) => {
        const resultObj = window.root.textToImagePlugin({
          prompt: opts.prompt,
          negativePrompt: opts.negativePrompt || undefined,
          seed: opts.seed === undefined ? undefined : opts.seed,
          guidanceScale: opts.guidanceScale === undefined ? undefined : opts.guidanceScale,
          resolution: opts.resolution || undefined,
          style: "z-index:10000; opacity:0.4; position:fixed; top:0.5rem; right:0.5rem; transform-origin:top right; transform:scale(0.3);",
        });
        let iframeEl = null;
        if (resultObj.iframeHtml) {
          const tmp = document.createElement("div");
          tmp.innerHTML = resultObj.iframeHtml;
          iframeEl = tmp.firstElementChild;
          document.body.append(iframeEl);
        }
        try {
          const data = await resultObj.onFinishPromise;
          return { dataUrl: data.dataUrl };
        } finally {
          if (iframeEl) iframeEl.remove();
        }
      },
      options
    ),
    new Promise((_, rej) => setTimeout(() => rej(new Error("image generation timed out")), IMG_TIMEOUT_MS)),
  ]);

  if (!result || !result.dataUrl) throw new Error("perchance returned no image (likely verification failure)");
  console.log("[bridge] image generation finished");
  lastImageVerifiedAt = Date.now();
  return result.dataUrl;
}

async function generateImage(options) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await generateImageOnce(options);
    } catch (e) {
      const retryable = /disconnected|closed|not ready|timed out|target closed|crashed/i.test(String(e.message));
      if (attempt >= 2 || !retryable) throw e;
      console.warn(`[bridge] image gen attempt ${attempt} failed, restarting image browser:`, e.message);
      await stopImageBrowser();
      await sleep(2000);
    }
  }
}

async function ensureReady() {
  if (!browserUp || !browser || !page || page.isClosed()) {
    await startBrowser("ensure-ready");
  }
  if (!browserUp) return false;
  if (!(await refreshTextFrame({ reason: "ensure-ready" }))) {
    browserUp = false;
    return false;
  }
  return true;
}

async function runKeepalive() {
  if (!browserUp || !genFrame) return;
  await genFrame.evaluate(() => {
    try { window.root.ai({ preload: true }); } catch (e) {}
  }).catch(() => {});
  lastKeepaliveAt = Date.now();
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

async function generateOnce({ messages, stop, onChunk }) {
  const ready = await ensureReady();
  if (!ready) throw new Error("perchance bridge browser is not ready");

  const instruction = messagesToPerchancePrompt(messages);
  const stopSequences = Array.isArray(stop) ? stop.slice(0, 8) : stop ? [stop] : [];
  stopSequences.push("\nUser:", "\nSystem:");

  let full = "";
  page.__ocBridgeOnChunk = (delta) => {
    full += delta;
    if (onChunk) { try { onChunk(delta); } catch (e) {} }
  };

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
      { instruction, stopSequences, chunkFnName: CHUNK_FN_NAME }
    ),
    new Promise((_, rej) => setTimeout(() => rej(new Error("generation timed out")), GEN_TIMEOUT_MS)),
  ]);

  page.__ocBridgeOnChunk = null;
  const text = (result && result.text) || full || "";
  if (!text.trim()) throw new Error("perchance returned no text (likely Turnstile/verification failure)");
  lastVerifiedAt = Date.now();
  lastKeepaliveAt = Date.now();
  return text.trim();
}

async function generate(opts) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await generateOnce(opts);
    } catch (e) {
      const retryable = /timed out|closed|disconnected|not ready|crashed|target page|browser has been closed/i.test(String(e.message));
      if (attempt >= 2 || !retryable) throw e;
      console.warn(`[bridge] text gen attempt ${attempt} failed:`, e.message);
      if (!(await recoverTextPage("gen-retry"))) await startBrowser("gen-retry");
      await sleep(3000);
    }
  }
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
  if (activeTextGenerations >= MAX_TEXT_CONCURRENCY) {
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

  activeTextGenerations++;
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
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "perchance", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
      try {
        await generate({ messages, stop: body.stop, onChunk: (d) => send(d, null) });
        send("", "stop");
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (e) {
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
    activeTextGenerations--;
  }
}

async function handleImageGeneration(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (e) { return sendJson(res, 400, { error: { message: "invalid JSON body" } }); }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) return sendJson(res, 400, { error: { message: "prompt required" } });

  try {
    const dataUrl = await enqueueImageTask(async () => {
      activeImageGenerations++;
      try {
        return await generateImage({
          prompt,
          negativePrompt: typeof body.negativePrompt === "string" ? body.negativePrompt : undefined,
          seed: body.seed,
          guidanceScale: body.guidanceScale,
          resolution: body.resolution,
        });
      } finally {
        activeImageGenerations--;
      }
    });
    sendJson(res, 200, { ok: true, dataUrl });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 503, { ok: false, error: { message: String(e.message), type: "bridge_unavailable" } });
  }
}

function extractPageContentInBrowser() {
  const pickMeta = (sel) => document.querySelector(sel)?.getAttribute("content")?.trim() || "";
  let title = pickMeta('meta[property="og:title"]') || pickMeta('meta[name="twitter:title"]') || (document.title || "").trim();
  const metaDesc = pickMeta('meta[name="description"]') || pickMeta('meta[property="og:description"]') || pickMeta('meta[name="twitter:description"]');
  let imageUrl = pickMeta('meta[property="og:image"]') || pickMeta('meta[name="twitter:image"]') || "";

  const jsonLdParts = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent || "");
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (typeof item?.description === "string") jsonLdParts.push(item.description);
        if (typeof item?.name === "string") jsonLdParts.push(item.name);
        if (typeof item?.headline === "string") jsonLdParts.push(item.headline);
        if (typeof item?.articleBody === "string") jsonLdParts.push(item.articleBody);
      }
    } catch (e) {}
  }

  const contentSelectors = [
    "#mw-content-text",
    ".mw-parser-output",
    ".WikiaArticle",
    ".page-content",
    ".article-content",
    ".post-content",
    "[role='main']",
    "main",
    "article",
    "#content",
    "#main-content",
  ];
  let contentRoot = null;
  for (const sel of contentSelectors) {
    const el = document.querySelector(sel);
    if (el && (el.innerText || "").replace(/\s+/g, " ").trim().length > 80) {
      contentRoot = el;
      break;
    }
  }
  if (!contentRoot) contentRoot = document.body || document.documentElement;

  let bodyText = (contentRoot?.innerText || "").replace(/\s+/g, " ").trim();
  if (bodyText.length < 80) {
    const headings = [...document.querySelectorAll("h1,h2,h3,p")].map((el) => (el.innerText || "").trim()).filter((t) => t.length > 20);
    if (headings.length) bodyText = headings.join("\n");
  }

  const text = [title, metaDesc, ...jsonLdParts, bodyText].filter(Boolean).join("\n\n");
  return { title, imageUrl, metaDesc, text, textLength: text.length };
}

async function fetchPageRendered(url) {
  const ctx = await ensureScrapeBrowser();
  const scrapePage = await ctx.newPage();
  try {
    console.log(`[bridge] rendering page for scrape: ${url.slice(0, 120)}`);
    await scrapePage.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await scrapePage.waitForTimeout(2500);
    await scrapePage.waitForSelector("#mw-content-text, .mw-parser-output, main, article, [role='main'], h1", { timeout: 8000 }).catch(() => {});
    const extracted = await scrapePage.evaluate(extractPageContentInBrowser);
    const html = await scrapePage.content();
    return { ok: true, url: scrapePage.url(), status: 200, html, extracted, rendered: true };
  } finally {
    await scrapePage.close();
  }
}

async function handleFetchPage(req, res) {
  let targetUrl;
  try {
    targetUrl = new URL(req.url, "http://localhost").searchParams.get("url");
  } catch (e) {
    return sendJson(res, 400, { error: { message: "bad request" } });
  }
  if (!targetUrl) return sendJson(res, 400, { error: { message: "url query param required" } });

  try {
    const result = await fetchPageRendered(targetUrl);
    sendJson(res, 200, result);
  } catch (e) {
    console.error("[bridge] fetch-page failed:", e.message);
    sendJson(res, 502, { ok: false, error: { message: "rendered fetch failed: " + e.message } });
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
    return sendJson(res, 200, {
      ok: browserUp,
      browserUp,
      ready: browserUp && lastVerifiedAt > 0,
      verifiedRecently: lastVerifiedAt > 0 && Date.now() - lastVerifiedAt < 45 * 60 * 1000,
      lastVerifiedAt,
      generator: GENERATOR,
      imageGenerator: IMAGE_GENERATOR,
      imageReady: !!(imageBrowserUp && imagePage && !imagePage.isClosed() && imageFrame),
      imageBrowserUp,
      lastImageVerifiedAt,
      activeTextGenerations,
      activeImageGenerations,
      maxTextConcurrency: MAX_TEXT_CONCURRENCY,
      maxImageConcurrency: MAX_IMAGE_CONCURRENCY,
    });
  }
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    return handleChatCompletion(req, res);
  }
  if (url.pathname === "/v1/images/generations" && req.method === "POST") {
    return handleImageGeneration(req, res);
  }
  if (url.pathname === "/v1/fetch-page" && req.method === "GET") {
    return handleFetchPage(req, res);
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
  await startBrowser("boot");
  if (PRELOAD_IMAGE) {
    ensureImageReady().then((ok) => {
      if (ok) console.log("[bridge] image generator preloaded");
      else console.warn("[bridge] image generator preload skipped/failed (will load on first image request)");
    }).catch(() => {});
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await generate({ messages: [{ role: "user", content: "Say hi in one word." }] });
      console.log("[bridge] warm-up generation succeeded - Turnstile verification OK");
      return;
    } catch (e) {
      console.warn(`[bridge] warm-up attempt ${attempt}/4 failed:`, e.message);
      if (attempt < 4) await sleep(8000);
    }
  }
  console.warn("[bridge] Perchance is not verified yet. The bridge will keep retrying in the background.");
})();

setInterval(async () => {
  if (activeTextGenerations > 0 || activeImageGenerations > 0 || healthBusy) return;
  healthBusy = true;
  try {
    if (!browserUp || !browser || !page || page.isClosed()) {
      if (browser && browser.isConnected() && context && (await recoverTextPage("health-check"))) return;
      await startBrowser("health-restart");
      return;
    }
    if (!(await refreshTextFrame({ reason: "health-check" }))) {
      browserUp = false;
      return;
    }
    if (Date.now() - lastKeepaliveAt > KEEPALIVE_MS) {
      await runKeepalive();
    }
  } catch (e) {
    console.error("[bridge] health loop error:", e.message);
  } finally {
    healthBusy = false;
  }
}, 60 * 1000);

process.on("SIGTERM", async () => { await stopBrowser(); await stopImageBrowser(); await stopScrapeBrowser(); process.exit(0); });
process.on("SIGINT", async () => { await stopBrowser(); await stopImageBrowser(); await stopScrapeBrowser(); process.exit(0); });
