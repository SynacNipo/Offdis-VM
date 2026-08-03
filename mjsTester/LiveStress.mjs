#!/usr/bin/env node
// Live stress test: watches a stream's live chat for N seconds, applies chat
// commands to the active VM, then reports throughput and failure stats.
// Usage: node LiveStress.mjs <videoId> [seconds] [vmName]
import { connect, setActive, onChatMessage } from '../src/cli.mjs';
import { runLiveLoop } from '../src/livechat.mjs';
import { setWriter, saveLogLines } from '../src/log.mjs';

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
const summaries = lines.filter((l) => l.includes(' → '));
const votes = lines.filter((l) => l.includes(' vote '));
let totalChars = 0, typeCount = 0;
for (const l of summaries) {
  for (const m of l.matchAll(/[✓✗] (!type|!send) ([^\]]*)\]/g)) {
    typeCount++;
    totalChars += m[2].length;
  }
}
const okBadges = summaries.reduce((n, l) => n + (l.match(/\[✓/g) || []).length, 0);
const badBadges = summaries.reduce((n, l) => n + (l.match(/\[✗/g) || []).length + (/→ ✗/.test(l) && !l.includes('[✗') ? 1 : 0), 0);
console.log('---- stats ----');
console.log('chat messages seen:', chatMsgs.length);
console.log('vote lines:', votes.length);
console.log('commands executed:', okBadges);
console.log('commands failed:', badBadges);
console.log('merged message+result lines:', summaries.length);
for (const f of summaries.filter((l) => /✗/.test(l))) console.log('  FAILED:', f);
if (typeCount) {
  console.log(`type/send commands: ${typeCount}, ${totalChars} chars total`);
}
const logFile = saveLogLines(lines, 'stress');
if (logFile) console.log('full log saved:', logFile);
process.exit(0);
