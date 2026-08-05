// DOM-scrape fallback for the live chat reader.
//
// The primary path (modern-youtubechat fetch) normally works, but YouTube
// rate-limits the InnerTube API hard (HTTP 429) - sometimes enough to kill a
// session. This module is Plan B: it launches a real browser (Chrome/Edge)
// onto the live chat popout page and scrapes the chat DOM over the Chrome
// DevTools Protocol (CDP), emitting only NEW messages (deduped by id, first
// poll primes the baseline). Uses the Node 22+ built-in WebSocket - no npm
// packages, just Node's built-ins.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log, settings } from '../../src/log.mjs';

const DEFAULTS = {
  enabled: true,
  headless: false,
  chromePath: 'auto',
  baseUrl: 'https://www.youtube.com/live_chat?is_popout=1&v=',
  publicFallback: true,
  // persistent Chrome profile folder ('' = throwaway temp profile).
  // Set this to a folder to keep cookies/login across fallback sessions -
  // needed for subscribers-only / members-only chat (sign in once in the
  // visible browser window, then restart the fallback).
  profileDir: '',
  pollMs: 1500,
  loadTimeoutMs: 30000,
  connectTimeoutMs: 15000,
};

const KNOWN_BROWSERS = {
  win32: [
    'Google/Chrome/Application/chrome.exe',
    'Microsoft/Edge/Application/msedge.exe',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jitter(ms) {
  const j = settings.livechat?.jitter ?? 0.25;
  return j > 0 ? ms * (1 - j + Math.random() * 2 * j) : ms;
}

function findBrowser(explicit) {
  if (explicit && explicit !== 'auto') {
    if (fs.existsSync(explicit)) return explicit;
    throw new Error(`fallback browser not found: ${explicit}`);
  }
  const candidates = [];
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA];
    for (const root of roots) {
      if (!root) continue;
      for (const rel of KNOWN_BROWSERS.win32) candidates.push(path.join(root, rel));
    }
  } else {
    candidates.push(...(KNOWN_BROWSERS[process.platform] || []));
  }
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('no Chrome/Edge found - set settings.livechat.fallback.chromePath');
}

function launchBrowser(videoId, cfg) {
  const exe = findBrowser(cfg.chromePath);
  const temp = !cfg.profileDir;
  const profile = temp
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'yt-chat-fb-'))
    : path.resolve(cfg.profileDir);
  fs.mkdirSync(profile, { recursive: true });
  const flags = [
    `--remote-debugging-port=0`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-sync',
    '--disable-component-update',
    '--metrics-recording-only',
    '--noerrdialogs',
  ];
  if (cfg.headless) flags.push('--headless=new', '--disable-gpu', '--hide-scrollbars');
  // Headless Chrome advertises itself via its UA; YouTube then refuses to
  // load chat ("update your browser"). Always report a normal Chrome UA.
  flags.push(
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    cfg.baseUrl + encodeURIComponent(videoId),
  );
  const proc = spawn(exe, flags, { stdio: 'ignore' });
  return { proc, profile, temp };
}

// Chrome writes its (random) debug port to DevToolsActivePort in the profile.
async function waitForPort(profile, timeoutMs) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const port = Number(fs.readFileSync(portFile, 'utf8').split(/\s+/)[0]);
      if (port) return port;
    } catch { /* not ready yet */ }
    await sleep(250);
  }
  return null;
}

async function findPageWs(port, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        const page = targets.find((t) => t.type === 'page' && /live_chat/i.test(t.url || ''))
          || targets.find((t) => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch { /* browser still booting */ }
    await sleep(250);
  }
  return null;
}

// Scrapes every chat item renderer off the popout DOM and returns JSON.
// `ready` is true once the item list renderer exists (chat panel loaded).
const SCRAPE_EXPR = `(() => {
  const txt = (el) => {
    let s = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) s += node.textContent;
      else if (node.nodeName === 'IMG') s += node.getAttribute('alt') || '';
      else if (node.nodeType === 1) s += txt(node);
    }
    return s;
  };
  const list = document.querySelector('yt-live-chat-item-list-renderer');
  const items = list ? [...list.querySelectorAll('yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer, yt-live-chat-paid-sticker-renderer, yt-live-chat-membership-item-renderer')] : [];
  const out = [];
  for (const el of items) {
    if (!el.id) continue;
    const badgeEl = el.querySelector('[id^="author-badge-"]');
    const authorEl = el.querySelector('#author-name');
    const msgEl = el.querySelector('#message') || el.querySelector('#header-subtext') || el.querySelector('#sticker');
    const message = msgEl ? txt(msgEl).trim() : '';
    if (!message) continue;
    out.push({
      id: el.id,
      author: authorEl ? authorEl.textContent.trim() : '',
      message,
      badge: badgeEl ? (badgeEl.getAttribute('label') || badgeEl.title || '') : '',
      kind: el.tagName.toLowerCase(),
    });
  }
  return JSON.stringify({ ready: !!list, path: location.pathname, url: location.href, title: document.title, items: out });
})()`;

// The studio popout bounces unauthenticated sessions to a sign-in page -
// bounce it onto the public youtube.com popout, which needs no login.
async function ensureChatPage(cdp, videoId, cfg) {
  const t0 = Date.now();
  while (Date.now() - t0 < cfg.loadTimeoutMs) {
    let res = null;
    try { res = JSON.parse(await cdp.evaluate(SCRAPE_EXPR) || 'null'); } catch { /* page busy */ }
    if (res && typeof res.path === 'string') {
      if (res.path === '/live_chat') return res;
      const bounced = /(accounts\.google|signin|consent|login)/i.test(res.url || '');
      if (cfg.publicFallback && bounced) {
        log.warn('live chat fallback: popout redirected to a login/consent page - retrying on youtube.com/live_chat');
        await cdp.send('Page.navigate', {
          url: `https://www.youtube.com/live_chat?is_popout=1&v=${encodeURIComponent(videoId)}`,
        });
      }
    }
    await sleep(500);
  }
  throw new Error('live chat fallback: chat page did not load in time');
}

function toChatMessage(item) {
  const badge = (item.badge || '').toLowerCase();
  let role = 'normal';
  if (/owner|broadcaster/.test(badge)) role = 'owner';
  else if (/moderator|^mod$|mod /.test(badge)) role = 'moderator';
  else if (/member/.test(badge)) role = 'member';
  else if (/verified/.test(badge)) role = 'verified';
  const kind = item.kind;
  const isMembership = kind === 'yt-live-chat-membership-item-renderer';
  const isPaid = kind === 'yt-live-chat-paid-message-renderer'
    || kind === 'yt-live-chat-paid-sticker-renderer';
  if (isMembership) role = 'member';
  return {
    id: item.id,
    author: { name: item.author, channelId: '', thumbnailUrl: undefined },
    message: item.message,
    timestamp: new Date(),
    timestampText: '',
    role,
    isMembership,
    isPaid,
  };
}

function cleanup(launched, cdp) {
  try { cdp?.close(); } catch { }
  const pid = launched.proc?.pid;
  if (pid) {
    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { }
    } else {
      try { launched.proc.kill('SIGKILL'); } catch { }
    }
  }
  // Windows can hold profile locks briefly after kill - retry after a beat.
  // Persistent profiles (temp: false) are left in place to keep the login.
  setTimeout(() => {
    if (launched.temp) {
      try { fs.rmSync(launched.profile, { recursive: true, force: true }); } catch { }
    }
  }, 1000);
}

// Minimal CDP client over the built-in WebSocket (Node 22+).
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.addEventListener('message', (e) => {
      let data;
      try { data = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)); } catch { return; }
      const entry = data.id && this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      if (data.error) entry.reject(new Error(`CDP error: ${data.error.message}`));
      else entry.resolve(data.result);
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('failed to open CDP websocket')), { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    return res.result?.value;
  }

  close() { try { this.ws?.close(); } catch { } }
}

// Main entry: a poll loop over the chat DOM. Only messages whose id has never
// been seen are emitted, and the first read (prime) sets the baseline so the
// pre-existing backlog is never replayed.
export async function runDomLoop(videoId, onMessage, isAborted, onConnected) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('DOM fallback needs Node 22+ (global WebSocket) - upgrade Node');
  }
  const cfg = { ...DEFAULTS, ...(settings.livechat?.fallback ?? {}) };
  const launched = launchBrowser(videoId, cfg);
  let cdp = null;
  try {
    const port = await waitForPort(launched.profile, cfg.connectTimeoutMs);
    if (!port) throw new Error('browser never exposed a debugging port');
    const wsUrl = await findPageWs(port, cfg.connectTimeoutMs);
    if (!wsUrl) throw new Error('browser page target not found');
    cdp = new Cdp(wsUrl);
    await cdp.connect();
    const page = await ensureChatPage(cdp, videoId, cfg);
    if (onConnected) onConnected(page.title || null, null);
    log.ok(`live chat fallback: scraping DOM at ${page.url}`);

    const seen = new Set();
    let primed = false;
    let notReadySince = null;
    while (true) {
      if (isAborted && isAborted()) return;
      let parsed = null;
      try { parsed = JSON.parse(await cdp.evaluate(SCRAPE_EXPR) || 'null'); } catch { /* page busy */ }
      if (parsed) {
        if (parsed.ready) {
          notReadySince = null;
          if (!primed) {
            primed = true;
            log.info('live chat fallback: primed - new messages only from here');
          }
          for (const item of parsed.items || []) {
            if (!item.id || seen.has(item.id)) continue;
            seen.add(item.id);
            onMessage(toChatMessage(item));
          }
        } else if (!notReadySince) {
          notReadySince = Date.now();
        } else if (Date.now() - notReadySince > 10000) {
          // Page is up but the chat panel never appeared (e.g. chat disabled
          // on the stream) - say so once instead of polling silently forever.
          notReadySince = null;
          log.warn('live chat fallback: chat panel not detected - stream may not have chat enabled');
        }
      }
      await sleep(jitter(cfg.pollMs));
    }
  } finally {
    cleanup(launched, cdp);
  }
}

// One-shot probe used by tests / mjsTester: launch, connect, load the chat
// page, scrape once, tear down. Returns the scraped state (no message loop).
export async function probeDomChat(videoId, cfg = {}) {
  const merged = { ...DEFAULTS, ...(settings.livechat?.fallback ?? {}), ...cfg };
  const launched = launchBrowser(videoId, merged);
  let cdp = null;
  try {
    const port = await waitForPort(launched.profile, merged.connectTimeoutMs);
    if (!port) return { ok: false, error: 'browser never exposed a debugging port' };
    const wsUrl = await findPageWs(port, merged.connectTimeoutMs);
    if (!wsUrl) return { ok: false, error: 'browser page target not found' };
    cdp = new Cdp(wsUrl);
    await cdp.connect();
    await ensureChatPage(cdp, videoId, merged);
    // The page is up at /live_chat but the chat panel can take a moment to
    // render - wait for the item list (or until the load timeout).
    const t0 = Date.now();
    let scraped = null;
    while (Date.now() - t0 < merged.loadTimeoutMs) {
      try { scraped = JSON.parse(await cdp.evaluate(SCRAPE_EXPR) || 'null'); } catch { }
      if (scraped?.ready) break;
      await sleep(500);
    }
    const page = scraped || {};
    return {
      ok: true,
      url: page.url || 'unknown',
      title: page.title || '',
      ready: !!(scraped?.ready),
      items: scraped?.items || [],
    };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    cleanup(launched, cdp);
  }
}
