(**Note**: This repo is in maintenance mode at the moment - bug fixes and small updates only. If you're working on adding substantial new features via a fork, please open an issue with a link and I'll put it here. Note that the system is very extensible via your character's [custom code](https://github.com/josephrocca/OpenCharacters/blob/main/docs/custom-code.md), so you should see if it's possible to achieve the feature that you want via that.)

![banner](https://user-images.githubusercontent.com/1167575/225629372-eb4de08a-ed62-4660-a83d-6e42a5c092d7.jpg)


<p align="center">Similar to CharacterAI, but open source, and with much deeper character customization.</p>

<p align="center"><b>⟶ <a href="https://plexflixplus.github.io/OpenCharacterss/">Try it!</a> ⟵</b></p>

<p align="center"><sub>Static demo: <a href="https://plexflixplus.github.io/OpenCharacterss/">GitHub Pages</a> (enable once in repo Settings → Pages → Deploy from branch <code>gh-pages</code>). For server-side chat sync, free Pollinations models, and reliable web-page character generation, run <code>node server.js</code> or <code>node daemon.js</code> on your own host.</sub></p>

<p align="center"><a href="https://discord.gg/5tkWXJFqPV">Discord Server</a></p>

## Features:
* The whole web app is a single HTML file - no server (serve it [locally](https://github.com/josephrocca/OpenCharacters/blob/main/docs/local-setup.md) if you want).
* All your data is stored in your browser's local storage (again, there is no server).
* Share characters with a link - all character data is embedded within the link.
* Auto-summarization algorithm (for old messages) which extends effective character memory/context size massively.
* Characters automatically compress messages into 'memories' and retrieve relevant memories based on context. Can handle as many memories as you need - tens of thousands or more.
* Add lorebook(s) to your character, and add thread-specific lore with the `/lore` command.
* Fully extensible with [custom code](https://github.com/josephrocca/OpenCharacters/blob/main/docs/custom-code.md). See examples [here](https://github.com/josephrocca/OpenCharacters/blob/main/docs/custom-code-examples.md).
  * Give your character access to the internet
  * Create your own slash commands
  * Give your character a video avatar (custom code has its own iframe & can display arbitrary content)
  * Create a "game master" [with a separate AI-powered process](https://tinyurl.com/5t3x8pdk) that tracks your abilities, inventory, etc.
  * Create your own memory structures (embedding, retrieval, etc.)
  * Give your character an internal thought process that runs alongside the chat
  * Give your character a voice via the browser's built-in TTS, or via an external API like ElevenLabs
  * Characters can [edit their own personality and custom code](https://tinyurl.com/4ccnn9zb) - self-improving and change over time
  * Allow your character to execute [Python](https://github.com/josephrocca/OpenCharacters/blob/main/docs/running-python-code.md) or JavaScript code.
* Currently supports OpenAI APIs [and most Hugging Face models](https://github.com/josephrocca/OpenCharacters/blob/main/docs/custom-models.md).
* Easily import character files and conversation data most other formats.
* Send new feature ideas or bug reports [here](https://github.com/josephrocca/OpenCharacters/issues) or on our [Discord server](https://discord.gg/5tkWXJFqPV).

## Server-side chat persistence (optional)

By default all data stays in your browser's IndexedDB. If you want your chats stored **server-side** (so they survive browser data clearing and follow you between browsers/devices), serve the app with the included zero-dependency Node server:

```bash
node server.js   # then open http://localhost:3000
```

When served this way, the app automatically syncs your characters, chats, messages, memories, summaries, lore, and usage stats to the server (stored in `server-data/chats.json`) every 10 seconds, and restores them on page load in any browser that doesn't have them yet. The server copy wins if it's newer than what a given browser has seen.

Notes:
* Your `misc` settings table (which contains your OpenAI API key) is **never** sent to or stored on the server.
* It's a single-user store with no authentication - don't expose it publicly without putting auth in front of it, since anyone who can reach the site can read/write the chats.
* If you serve the app any other way (e.g. GitHub Pages or `python3 -m http.server`), sync silently disables itself and everything works exactly as before (browser-local storage only).

## Free models (no API key) & the Perchance AI bridge

When you serve the app with the included Node server (`node server.js`, or the supervisor `node daemon.js`), extra **free, no-API-key** models appear in the model dropdown under a "Free (no API key)" group:

* **Pollinations** (`pollinations`) — a free, community-hosted, OpenAI-compatible endpoint (currently GPT-OSS-20B). Works out of the box; the server proxies requests to it (the provider blocks direct browser requests). Just pick it in the model dropdown and start chatting — no key required.
* **Perchance AI** (`perchance`) — see the bridge below. Only shown once the bridge has successfully verified.

These are registered automatically at startup by probing `/api/health`. If you open the app as a static file (no server), these options simply don't appear and everything else works as before.

### Perchance AI bridge

Perchance has **no official public API** — its AI text plugin runs on Perchance's own ad-funded GPU servers and is gated behind a Cloudflare Turnstile human check tied to a real browser session on a perchance.org page. The bridge (`perchance-bridge.js`) is the only thing that actually works: it drives a real browser (via Playwright) that loads a genuine Perchance generator, lets it pass Turnstile normally, and calls the in-page generation function, exposing the result as an OpenAI-compatible endpoint that the app proxies at `/api/perchance/*`.

To enable it:

```bash
npm install playwright && npx playwright install chromium
node daemon.js   # supervises server.js + the bridge, restarting either if it exits
```

The daemon keeps the bridge alive at all times (auto-restart with backoff), and the bridge is self-healing (re-navigates/re-launches the browser and re-verifies periodically). If there's no display it runs the browser headed under `xvfb` automatically when available.

> **Important:** Cloudflare Turnstile usually **refuses to verify from datacenter/cloud IPs**. In that case the bridge reports itself "not ready", the `perchance` model is hidden, and Pollinations (which needs no verification) is used instead. Run the bridge from a **residential connection** (e.g. your own machine or a home server) for Perchance to work. Please use it responsibly — the plugin is normally ad-funded.

Relevant env vars: `PERCHANCE_BRIDGE_PORT` (default 8080), `PERCHANCE_GENERATOR` (default `ai-text-plugin-tester`), `PERCHANCE_HEADLESS` (`true` to force headless), `DISABLE_PERCHANCE_BRIDGE` (`true` to skip it).

## Generate a character from any web page

Click **🌐 from web page** on the Characters screen, paste any URL (a Wikipedia article, a blog post, a fandom page, etc.), optionally add a hint, and the AI builds a ready-to-chat character from that page — name, personality/role instruction, greeting, and an avatar taken from the page's preview image. It defaults to a free model so it works without an API key, then drops you into the normal character editor to review and tweak before saving.

The page is fetched server-side via `/api/fetch-page` (no CORS limits); if you're running the app as a static file it falls back to a direct fetch and then the configurable CORS proxy.

**Bookmarklet:** you can trigger this from *any* page you're browsing. Make a bookmark whose URL is the following (replace the base URL with wherever you host OpenCharacters):

```js
javascript:(()=>{location.href='https://plexflixplus.github.io/OpenCharacterss/#'+encodeURIComponent(JSON.stringify({generateCharacterFromUrl:location.href}))})()
```

Clicking it opens OpenCharacters already generating a character from the page you were on. The same `#{"generateCharacterFromUrl":"https://..."}` URL-hash command works if you construct the link yourself.

## Changelog

Please see the `#announcements` channel on the [Discord server](https://discord.gg/5tkWXJFqPV) for latest updates.
