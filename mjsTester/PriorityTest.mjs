import { connect, setActive, execCommand } from '../src/cli.mjs';
import { settings } from '../src/log.mjs';
console.log('typing.maxLength =', settings.typing?.maxLength ?? 0);
await connect();
await setActive('Windows-7-7601');
try {
  await execCommand('!send ' + 'a'.repeat(100));
  console.log('FAIL: 100 chars was accepted');
} catch (e) {
  console.log('OK rejected 100 chars:', e.message);
}
await execCommand('!type short ok');
console.log('OK short type accepted');
process.exit(0);
