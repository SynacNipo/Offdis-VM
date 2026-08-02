import { connect, whenIdle, handle } from '../src/cli.mjs';
await connect();
await handle('key ?');
await handle('wait 100');
await handle('voteban');
await handle('type ok');
await whenIdle();
console.log('DONE');
process.exit(0);
