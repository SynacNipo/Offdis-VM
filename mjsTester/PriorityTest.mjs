import { connect, whenIdle, handle } from '../src/cli.mjs';
await connect();
await handle('startvm');
await whenIdle();
console.log('DONE');
process.exit(0);
