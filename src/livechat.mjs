import { initLiveChat, pollChat } from '../modern-youtubechat/dist/client.js';
import { log } from './log.mjs';

export { initLiveChat, pollChat };

// Transient YouTube overloads (429 / 5xx) come and go in seconds - back off
// and retry instead of killing the whole loop. Only real failures (stream
// ended, auth, network death) propagate and disconnect live chat.
const MAX_RETRIES = 12;
const BACKOFF_BASE_MS = 1500;

export async function runLiveLoop(videoId, onMessage, isAborted) {
  let config = await initLiveChat(videoId);
  let primed = false;
  let fails = 0;
  while (true) {
    if (isAborted && isAborted()) return;
    try {
      const result = await pollChat(config);
      fails = 0;
      if (primed) {
        for (const msg of result.messages) onMessage(msg);
      } else {
        primed = true;
      }
      config = result.config;
      await new Promise((r) => setTimeout(r, 700));
    } catch (err) {
      const m = /Poll failed: (\d{3})/.exec(err.message);
      const transient = m && (m[1] === '429' || m[1] >= 500);
      if (!transient) throw err;
      fails++;
      if (fails > MAX_RETRIES) throw err;
      const backoff = Math.min(10000, BACKOFF_BASE_MS * fails);
      log.warn(`live chat: poll ${m[1]}, retrying in ${backoff / 1000}s (${fails}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}
