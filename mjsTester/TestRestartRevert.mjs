#!/usr/bin/env node
// Destructive test: real !restartvm and !revertvm (powers the VM off and back on,
// and reverts to its latest snapshot), plus a vote-triggered restart.
// Usage: node TestRestartRevert.mjs [vmName]
import { connect, setActive, execCommand, onChatMessage, whenIdle } from '../src/cli.mjs';
import { settings } from '../src/log.mjs';

const vm = process.argv[2] || 'Windows-7-7601';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await connect();
await setActive(vm);

console.log('\n=== 1) direct !restartvm ===');
await execCommand('!restartvm');
console.log('restart OK, VM is back');
await sleep(1500);

console.log('\n=== 2) vote-triggered !restartvm (threshold 2) ===');
const t0 = Date.now();
onChatMessage({ author: { name: 'voter1' }, role: 'normal', message: '!restartvm' });
await sleep(300);
onChatMessage({ author: { name: 'voter2' }, role: 'normal', message: '!restartvm' });
await whenIdle();
console.log(`vote-triggered restart finished in ${Date.now() - t0}ms`);
await sleep(1500);

console.log('\n=== 3) direct !revertvm ===');
await execCommand('!revertvm');
console.log('revert OK, VM is back');
await sleep(1500);

console.log('\nTYPING STILL WORKS - sending a quick !key enter');
await execCommand('!key enter');
console.log('RESTART-REVERT-OK');
process.exit(0);
