import { Terminal } from '../src/prompt.mjs';

const t = new Terminal();

const p = t.prompt('vbox> ');
t.onData(Buffer.from('lis'));
t.onData(Buffer.from('t'));
t.onData(Buffer.from([0x0d]));
console.log('prompt line:', JSON.stringify(await p));

const m = t.menu('Pick', ['a', 'b', 'c'], 'hint');
t.onData(Buffer.from([0x1b, 0x5b, 0x42]));
t.onData(Buffer.from([0x1b, 0x5b, 0x42]));
t.onData(Buffer.from([0x0d]));
console.log('picked:', JSON.stringify(await m));

const p2 = t.prompt('> ');
t.write('chat message while typing');
t.onData(Buffer.from('x'));
t.onData(Buffer.from([0x0d]));
console.log('line2:', JSON.stringify(await p2));

const p3 = t.prompt('> ');
t.onData(Buffer.from([0x03]));
console.log('ctrl-c:', JSON.stringify(await p3));

const p4 = t.prompt('> ');
t.onData(Buffer.from([0x08]));
t.onData(Buffer.from('hi'));
t.onData(Buffer.from([0x0d]));
console.log('backspace:', JSON.stringify(await p4));

console.log('TERMINAL-OK');
process.exit(0);
