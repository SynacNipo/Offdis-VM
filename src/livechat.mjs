import { initLiveChat, pollChat } from '../modern-youtubechat/dist/client.js';
import { log, settings } from './log.mjs';

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

export async function runLiveLoop(videoId, onMessage, isAborted, onConnected) {
  const cfg = settings.livechat ?? {};
  const fastMs = cfg.fastMs ?? 700;
  const idleMs = cfg.idleMs ?? 10000;
  const maxMs = cfg.maxMs ?? 6000;

  let config = await withRetry('video page', () => initLiveChat(videoId));
  if (onConnected) onConnected(config.title, config.host);
  let primed = false;
  let lastMessageAt = Date.now();
  let interval = fastMs;
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
}
