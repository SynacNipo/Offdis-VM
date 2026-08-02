import { initLiveChat, pollChat } from '../modern-youtubechat/dist/client.js';

export { initLiveChat, pollChat };

export async function runLiveLoop(videoId, onMessage, isAborted) {
  let config = await initLiveChat(videoId);
  let primed = false;
  while (true) {
    if (isAborted && isAborted()) return;
    const result = await pollChat(config);
    if (primed) {
      for (const msg of result.messages) onMessage(msg);
    } else {
      primed = true;
    }
    config = result.config;
    await new Promise((r) => setTimeout(r, 700));
  }
}
