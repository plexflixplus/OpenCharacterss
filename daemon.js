// OpenCharacters process supervisor / keep-alive daemon
// =====================================================
//
// Keeps the web server and the Perchance bridge running "at all times": if either
// child process exits (crash, OOM, whatever), it is automatically restarted with an
// exponential backoff. Run this instead of starting the processes by hand:
//
//   node daemon.js
//
// What it starts:
//   1. server.js            - serves the app + /api/sync + /api/perchance proxy + /api/fetch-page
//   2. perchance-bridge.js  - the headless-browser Perchance AI bridge (optional)
//
// The Perchance bridge is only started if Playwright is installed. If you want to
// run the bridge "headed" (needed to pass Cloudflare Turnstile on most servers) and
// there's no display, the daemon will automatically wrap it in `xvfb-run` when that
// is available.
//
// Env vars:
//   PORT                      web server port (default 3000)
//   PERCHANCE_BRIDGE_PORT     bridge port (default 8080) - server.js proxies to this
//   DISABLE_PERCHANCE_BRIDGE  set to "true" to not start the bridge at all
//   PERCHANCE_HEADLESS        "true" => run bridge headless (no xvfb wrapping)

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = __dirname;

function has(cmd) {
  try { return spawnSync("bash", ["-lc", `command -v ${cmd}`], { encoding: "utf8" }).stdout.trim() !== ""; }
  catch (e) { return false; }
}

function playwrightInstalled() {
  try { require.resolve("playwright", { paths: [ROOT] }); return true; } catch (e) { return false; }
}

// A supervised child: restarts on exit with capped exponential backoff.
function supervise(name, buildSpawn) {
  let backoff = 1000;
  const MAX_BACKOFF = 30000;
  let stopped = false;

  function start() {
    if (stopped) return;
    const { command, args, options } = buildSpawn();
    console.log(`[daemon] starting ${name}: ${command} ${args.join(" ")}`);
    const child = spawn(command, args, { stdio: "inherit", cwd: ROOT, ...options });

    child.on("exit", (code, sig) => {
      if (stopped) return;
      console.warn(`[daemon] ${name} exited (code=${code}, signal=${sig}); restarting in ${backoff}ms`);
      setTimeout(start, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    });
    child.on("error", (e) => {
      console.error(`[daemon] ${name} spawn error:`, e.message);
    });
    // if it survives a while, reset the backoff
    setTimeout(() => { if (!child.killed) backoff = 1000; }, 20000);

    supervise._children.push(child);
  }
  start();
}
supervise._children = [];

// 1) web server
supervise("web-server", () => ({
  command: process.execPath,
  args: [path.join(ROOT, "server.js")],
  options: {},
}));

// 2) perchance bridge (optional)
const bridgeDisabled = String(process.env.DISABLE_PERCHANCE_BRIDGE || "").toLowerCase() === "true";
if (bridgeDisabled) {
  console.log("[daemon] Perchance bridge disabled via DISABLE_PERCHANCE_BRIDGE");
} else if (!playwrightInstalled()) {
  console.log("[daemon] Perchance bridge NOT started (Playwright not installed).");
  console.log("[daemon]   To enable it: npm install playwright && npx playwright install chromium");
} else {
  const headless = String(process.env.PERCHANCE_HEADLESS || "").toLowerCase() === "true";
  const needXvfb = !headless && !process.env.DISPLAY && has("xvfb-run");
  supervise("perchance-bridge", () => {
    const bridgeScript = path.join(ROOT, "perchance-bridge.js");
    if (needXvfb) {
      return {
        command: "xvfb-run",
        args: ["-a", "--server-args=-screen 0 1280x900x24", process.execPath, bridgeScript],
        options: {},
      };
    }
    return { command: process.execPath, args: [bridgeScript], options: {} };
  });
  if (needXvfb) console.log("[daemon] Perchance bridge will run headed under xvfb-run");
}

function shutdown() {
  console.log("[daemon] shutting down children...");
  for (const c of supervise._children) { try { c.kill("SIGTERM"); } catch (e) {} }
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("[daemon] supervisor running. Press Ctrl+C to stop.");
