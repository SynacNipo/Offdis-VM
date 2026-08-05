import { initLiveChat, pollChat } from '../modern-youtubechat/dist/client.js';
import { log, settings } from './log.mjs';
import { runDomLoop } from '../modern-youtubechat/FallbackDOMcontent/fallback-chat.mjs';

export { initLiveChat, pollChat };

// Transient YouTube overloads (429 / 5xx) come and go in seconds - back off
// and retry instead of killing the whole loop. Only real failures (stream
// ended, auth, network death) propagate and disconnect live chat.
function transientStatus(err) {
  const m = /(?:Poll failed|Failed to fetch video page): (\d{3})/.exec(err?.message || '');
  if (!m) return null;
  const code = Number(m[1]);
  return code === 429 || code >= 500 ? code : null;
}

function jitter(ms) {
  const j = settings.livechat?.jitter ?? 0.25;
  return j > 0 ? ms * (1 - j + Math.random() * 2 * j) : ms;
}

async function withRetry(what, fn) {
  const max = settings.livechat?.maxRetries ?? 12;
  const base = settings.livechat?.backoffBaseMs ?? 1500;
  let fails = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const code = transientStatus(err);
      if (code === null) throw err;
      fails++;
      if (fails > max) throw err;
      const backoff = Math.min(10000, base * fails);
      log.warn(`live chat: ${what} ${code}, retrying in ${backoff / 1000}s (${fails}/${max})`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

// The fetch path was killed by persistent transient failures (429/5xx) - hand
// the whole session over to the DOM fallback until the API answers again.
// `enabled: false` in settings keeps the old hard-fail behavior.
async function fallbackToDom(videoId, onMessage, isAborted, onConnected, reason) {
  const fb = settings.livechat?.fallback;
  if (fb && fb.enabled === false) {
    throw new Error(`live chat fetch failed (${reason}) and the DOM fallback is disabled`);
  }
  log.warn(`live chat: fetch path failing (${reason}) - switching to DOM fallback`);
  // runDomLoop returns { switched: true } once it detected the fetch API
  // recovered and closed the browser; anything else (or a throw) ends the
  // session.
  const out = await runDomLoop(videoId, onMessage, isAborted, onConnected);
  return !!(out && out.switched);
}

export async function runLiveLoop(videoId, onMessage, isAborted, onConnected) {
  const cfg = settings.livechat ?? {};
  const fastMs = cfg.fastMs ?? 700;
  const idleMs = cfg.idleMs ?? 10000;
  const maxMs = cfg.maxMs ?? 6000;

  // A fallback switch-back starts a fresh fetch session; the loop is re-entered
  // until the stream ends for real or the session is aborted.
  for (;;) {
    if (isAborted && isAborted()) return;
    let config;
    try {
      config = await withRetry('video page', () => initLiveChat(videoId));
    } catch (err) {
      // Rate-limited hard on the very first fetch - the fetch path is unusable
      // for this stream, so the fallback takes over from the start.
      if (transientStatus(err) !== null) {
        if (await fallbackToDom(videoId, onMessage, isAborted, onConnected, err.message)) continue;
        return;
      }
      throw err;
    }
    if (onConnected) onConnected(config.title, config.host);
    let primed = false;
    let lastMessageAt = Date.now();
    let interval = fastMs;
    try {
      while (true) {
        if (isAborted && isAborted()) return;
        const result = await withRetry('poll', () => pollChat(config));
        if (primed) {
          if (result.messages.length) {
            for (const msg of result.messages) onMessage(msg);
            lastMessageAt = Date.now();
            interval = fastMs;
          }
        } else {
          primed = true;
        }
        config = result.config;
        if (Date.now() - lastMessageAt > idleMs && interval < maxMs) {
          interval = Math.min(maxMs, Math.round(interval * 1.5));
        }
        await new Promise((r) => setTimeout(r, jitter(interval)));
      }
    } catch (err) {
      // Only persistent transient (429/5xx) failures hand off to the fallback;
      // stream-ended / auth / network errors still surface as real failures.
      // onConnected already fired, so the fallback skips re-announcing.
      if (transientStatus(err) !== null) {
        if (await fallbackToDom(videoId, onMessage, isAborted, null, err.message)) continue;
        return;
      }
      throw err;
    }
  }
}
