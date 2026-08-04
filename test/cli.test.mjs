import test from 'node:test';
import assert from 'node:assert/strict';
import { execCommand } from '../src/cli.mjs';

test('unknown commands are rejected', async () => {
  await assert.rejects(() => execCommand('!bogus'), /unknown command '!bogus'/);
});

test('!wait executes without a bridge', async () => {
  const r = await execCommand('!wait 50ms');
  assert.deepEqual(r, { executed: true });
});

test('aliases route to their canonical command', async () => {
  // sendm -> send, start -> startvm, revert -> revertvm, restart -> restartvm:
  // the bridge rejection proves the canonical handler ran (not "unknown
  // command") and actually tried to reach the bridge.
  await assert.rejects(() => execCommand('!sendm x'), /bridge is not running/);
  await assert.rejects(() => execCommand('!start'), /bridge is not running/);
  await assert.rejects(() => execCommand('!revert'), /bridge is not running/);
  await assert.rejects(() => execCommand('!restart'), /bridge is not running/);
});
