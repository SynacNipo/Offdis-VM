#!/usr/bin/env node
// Test keyboard: sends A-Z, a-z and 0-9 to a VM via the COM bridge.
// Usage: node TestKeyboard.mjs [vmName]   (default: Windows-7-7601)
import { Bridge } from '../src/bridge.mjs';
import { resolveKey } from '../src/scancodes.mjs';

const vm = process.argv[2] || 'Windows-7-7601';
const DELAY_MS = 30;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const bridge = new Bridge();
  await bridge.connect();
  console.log(`Connected to VirtualBox ${bridge.version}`);

  const res = await bridge.call('select', { name: vm });
  console.log(`Active: ${res.name} [${res.stateName}]`);

  let sent = 0;
  async function send(label, codes) {
    await bridge.call('key', { codes });
    sent++;
    process.stdout.write(`${label} `);
    await sleep(DELAY_MS);
  }

  for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
    await send(ch, resolveKey(ch));
  }
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    await send(`S+${ch.toLowerCase()}`, resolveKey(`shift+${ch.toLowerCase()}`));
  }
  for (const ch of '0123456789') {
    await send(ch, resolveKey(ch));
  }

  console.log(`\nDone: ${sent} key sequences sent to ${vm}`);
  await bridge.close();
}

main().catch((err) => {
  console.error(`failed: ${err.message}`);
  process.exit(1);
});
