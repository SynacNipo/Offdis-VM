#!/usr/bin/env node
// Typing speed / drop test: opens notepad in the VM and sends the same line
// multiple times, reporting chars/s after each line.
// Usage: node TypeTest.mjs [vmName] [lines] [text...]
import { connect, setActive, execCommand } from '../src/cli.mjs';

const vm = process.argv[2] || 'Windows-7-7601';
const lines = parseInt(process.argv[3] || '3', 10);
const text = process.argv.slice(4).join(' ') ||
  'the fox lazily jumped over the brown thing The Quick Brown Fox 1234567890';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await connect();
await setActive(vm);

console.log('opening notepad...');
await execCommand('!combo win+r');
await execCommand('!wait 800');
await execCommand('!type notepad');
await execCommand('!key enter');
await sleep(1500);

for (let i = 1; i <= lines; i++) {
  const t0 = Date.now();
  await execCommand(`!send RETYPE-TEST-${i} ${text}`);
  const ms = Date.now() - t0;
  const cps = text.length / (ms / 1000);
  console.log(`line ${i}: ${text.length} chars in ${ms}ms => ${cps.toFixed(1)} chars/s`);
}

console.log('expected each line:');
console.log('RETYPE-TEST-N ' + text);
console.log('TYPETEST-DONE');
process.exit(0);
