#!/usr/bin/env node
// Live stress test: watches a stream's live chat for N seconds, applies chat
// commands to the active VM, then reports throughput and failure stats.
// Usage: node LiveStress.mjs <videoId> [seconds] [vmName]
import { connect, setActive, onChatMessage } from '../src/cli.mjs';
import { runLiveLoop } from '../src/livechat.mjs';
import { setWriter } from '../src/log.mjs';

const videoId = process.argv[2];
const seconds = parseInt(process.argv[3] || '120', 10);
const vm = process.argv[4] || 'Windows-7-7601';

if (!videoId) {
  console.log('usage: node LiveStress.mjs <videoId> [seconds] [vmName]');
  process.exit(1);
}

const lines = [];
setWriter((t) => lines.push(t));

await connect();
await setActive(vm);

let aborted = false;
const loop = runLiveLoop(videoId, onChatMessage, () => aborted);
console.log(`watching live chat for ${seconds}s ...`);
await new Promise((r) => setTimeout(r, seconds * 1000));
aborted = true;
await loop.catch(() => { });

const chatMsgs = lines.filter((l) => /^\d{2}:\d{2}:\d{2} @/.test(l));
const executed = lines.filter((l) => l.includes('Executed :'));
const failed = lines.filter((l) => l.includes('Failed :'));
const votes = lines.filter((l) => l.includes(' vote '));
let totalChars = 0, totalMs = 0, typeCount = 0;
for (const l of executed) {
  const m = l.match(/Time: (\d+)ms/);
  const cmd = l.match(/Executed : "(!type|!send) ([\s\S]*?)" by/);
  if (m && cmd) { totalMs += +m[1]; totalChars += cmd[2].length; typeCount++; }
}
console.log('---- stats ----');
console.log('chat messages seen:', chatMsgs.length);
console.log('vote lines:', votes.length);
console.log('commands executed:', executed.length);
console.log('commands failed:', failed.length);
for (const f of failed) console.log('  FAILED:', f);
if (typeCount) {
  console.log(`type/send commands: ${typeCount}, avg ${(totalChars / (totalMs / 1000)).toFixed(1)} chars/s across ${totalMs}ms of typing`);
}
process.exit(0);
