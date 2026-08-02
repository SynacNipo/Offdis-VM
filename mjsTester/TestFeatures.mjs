#!/usr/bin/env node
// Feature test: active VM, typing, sending, combos, macros (via exported CLI internals).
// Usage: node TestFeatures.mjs [vmName]
import { connect, setActive, execCommand, parseChatCommands } from '../src/cli.mjs';

const vm = process.argv[2] || 'Windows-7-7601';

await connect();
await setActive(vm);

await execCommand('!type Hello World 123');
await execCommand('!send cmd /c echo hi');
await execCommand('!combo win+r');
await execCommand('!import this');

const parsed = parseChatCommands('@author : !key win !send cmd !import this');
console.log('parsed chat commands:', JSON.stringify(parsed));

console.log('FEATURES-OK');
process.exit(0);
