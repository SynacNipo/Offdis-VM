import { initLiveChat, pollChat } from '../modern-youtubechat/dist/client.js';

const videoId = 'O-dl8bXc1q8';
const timeoutMs = 30000;
const started = Date.now();

console.log(`connecting to ${videoId}...`);
let config = await initLiveChat(videoId);
console.log('connected. waiting for chat messages...');
let primed = false;
let count = 0;

while (Date.now() - started < timeoutMs) {
  const result = await pollChat(config);
  if (primed) {
    for (const msg of result.messages) {
      count++;
      console.log(`[${msg.role}] @${msg.author.name}: ${msg.message}`);
      if (count >= 8) { console.log('got 8 messages - ok'); process.exit(0); }
    }
  } else {
    primed = true;
    console.log('primed (skipping backlog)');
  }
  config = result.config;
  await new Promise((r) => setTimeout(r, 700));
}
console.log(`timeout after ${timeoutMs}ms, ${count} messages`);
process.exit(0);
