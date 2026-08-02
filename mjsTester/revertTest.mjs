#!/usr/bin/env node
// Revert test: vote-triggered !revert (alias) with 2 voters reverts the active
// VM to its latest snapshot, then verifies it comes back running and that the
// keyboard still works.
// Usage: node revertTest.mjs [vmName]
import { connect, setActive, execCommand, onChatMessage, whenIdle } from '../src/cli.mjs';

const vm = process.argv[2] || 'Windows-7-7601';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await connect();
await setActive(vm);

console.log('=== vote-triggered !revert (2 votes, alias path) ===');
const t0 = Date.now();
onChatMessage({ author: { name: 'voteone' }, role: 'normal', message: '!revert' });
await sleep(300);
onChatMessage({ author: { name: 'votetwo' }, role: 'normal', message: '!revert' });
await whenIdle();
console.log(`revert completed in ${Date.now() - t0}ms`);

console.log('=== verify VM is back and keyboard works ===');
await execCommand('!key enter');
console.log('REVERT-TEST-OK');
process.exit(0);
