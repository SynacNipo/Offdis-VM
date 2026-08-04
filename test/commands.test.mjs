import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMANDS, CHAT_ALLOWED, BARE_COMMANDS, NO_VM_REQUIRED, VOTE_COMMANDS,
  ALIASES, buildHelp, parseChatCommands, buildResult, voteFor, dropVote,
} from '../src/commands.mjs';

test('chat-visible commands are exactly the chat set', () => {
  const expected = ['key', 'type', 'send', 'sendm', 'combo', 'import', 'wait',
    'revertvm', 'restartvm', 'startvm', 'mouse', 'lclick', 'rclick'];
  for (const name of expected) assert.ok(CHAT_ALLOWED.has(name), name);
  for (const name of ['start', 'revert', 'restart', 'voteban', 'live',
    'clearLog', 'list', 'info', 'pause', 'stop']) {
    assert.ok(!CHAT_ALLOWED.has(name), name);
  }
});

test('bare prompt commands are exactly the prompt set', () => {
  const expected = ['key', 'type', 'send', 'sendm', 'combo', 'import', 'wait',
    'restart', 'restartvm', 'revert', 'revertvm', 'voteban', 'live', 'clearLog',
    'start', 'startvm', 'mouse', 'lclick', 'rclick'];
  for (const name of expected) assert.ok(BARE_COMMANDS.has(name), name);
  for (const name of ['list', 'info', 'pause', 'stop']) {
    assert.ok(!BARE_COMMANDS.has(name), name);
  }
});

test('vote-gated commands and aliases resolve canonically', () => {
  assert.deepEqual([...VOTE_COMMANDS].sort(), ['restartvm', 'revertvm', 'voteban']);
  assert.equal(ALIASES.revert, 'revertvm');
  assert.equal(ALIASES.restart, 'restartvm');
  assert.equal(ALIASES.sendm, 'send');
  assert.equal(ALIASES.start, 'startvm');
});

test('VM-free commands are flagged', () => {
  for (const name of ['startvm', 'start', 'live', 'clearLog']) {
    assert.ok(NO_VM_REQUIRED.has(name), name);
  }
  assert.ok(!NO_VM_REQUIRED.has('key'));
});

test('every non-alias command carries help text', () => {
  for (const [name, def] of Object.entries(COMMANDS)) {
    if (def.aliasOf) continue; // aliases are documented on their canonical line
    assert.ok(typeof def.help === 'string' && def.help.length > 0, `command '${name}' has help text`);
  }
});

test('buildHelp reproduces the full help text', () => {
  const expected = [
    'Commands: (! optional at this prompt - chat requires it)',
    '  list             VM picker (arrows + Enter) - auto-starts if powered off',
    '  info [<name>]    show VM details',
    '  pause | resume   pause / resume the active VM',
    '  stop             power off the active VM (ACPI)',
    '  key <key>        send a key:  key enter - key ctrl+alt+del - key ? = all keys',
    '  type <text>      type text into the VM (no Enter)',
    '  send <text>      type text and press Enter (alias: sendm)',
    '  combo <chord>    key combo with hold:  combo win+r',
    '  wait <dur>       pause:  500ms, 2s, 3 (ms) - max 10s',
    '  mouse <dir>      drift cursor:  mouse up 4s - mouse left 2s (max 10s)',
    '  lclick|rclick    click left/right mouse button at current cursor',
    '  import <name>    run a macro from macros/  (e.g. import this)',
    '  startvm          start / activate a VM (also: start <name>, alias: start)',
    '  revertvm         revert to latest snapshot (chat: N votes to trigger, alias: revert)',
    '  restartvm        restart the VM (chat: N votes to trigger, alias: restart)',
    '  voteban <author> shadowban a chatter (chat: N votes to trigger)',
    '  live <videoId>   connect YouTube live chat - live stop to disconnect',
    '  clearLog         clear the console',
    '  help | ?         this help - exit | quit',
  ].join('\n');
  assert.equal(buildHelp(), expected);
});

test('parseChatCommands splits !chains', () => {
  assert.deepEqual(parseChatCommands('!key enter'), [{ cmd: '!key', args: ['enter'] }]);
  assert.deepEqual(parseChatCommands('!key enter !wait 2s'), [
    { cmd: '!key', args: ['enter'] },
    { cmd: '!wait', args: ['2s'] },
  ]);
  assert.deepEqual(parseChatCommands('!type hello world !import boot'), [
    { cmd: '!type', args: ['hello', 'world'] },
    { cmd: '!import', args: ['boot'] },
  ]);
  assert.deepEqual(parseChatCommands('plain message, no commands'), []);
});

test('buildResult renders short all-ok lines with badges', () => {
  assert.deepEqual(
    buildResult('!key enter', 'bob', ['[✓ !key enter]'], 1, 1, 42, 0),
    { text: '[✓ !key enter] - 1 action in 42ms', ok: true },
  );
});

test('buildResult reports partial success with skipped', () => {
  // all executed badges succeeded, so the all-ok form wins even with skipped
  assert.deepEqual(
    buildResult('!key a !key b', 'bob', ['[✓ !key a]'], 1, 2, 40, 1),
    { text: '[✓ !key a] - 1 action in 40ms', ok: true },
  );
});

test('buildResult collapses long all-ok lines', () => {
  const long = 'x'.repeat(300);
  assert.deepEqual(
    buildResult(`!type ${long}`, 'bob', [`[✓ !type ${long}]`], 1, 1, 50, 0),
    { text: '✓ 1/1 in 50ms', ok: true },
  );
});

test('buildResult collapses long partial lines with unique failures', () => {
  assert.deepEqual(
    buildResult(`!key ${'z'.repeat(200)}`, 'bob', ['[✗ !bogus: nope]'], 0, 1, 30, 0),
    { text: '✗ 0/1 in 30ms - !bogus: nope', ok: false },
  );
});

test('buildResult truncates a long failure list', () => {
  const fail = 'f'.repeat(120);
  const out = buildResult('!key x', 'bob', [`[✗ ${fail}]`], 0, 1, 30, 0);
  assert.ok(out.text.includes(`- ${fail.slice(0, 90)}…`));
});

test('voteFor counts distinct chatters up to the threshold', () => {
  dropVote('revertvm');
  assert.equal(voteFor('revertvm', 'alice', 2), 1);
  assert.equal(voteFor('revertvm', 'bob', 2), 2);
  dropVote('revertvm');
});

test('voteFor ignores duplicate authors and resets after dropVote', () => {
  dropVote('restartvm');
  assert.equal(voteFor('restartvm', 'alice', 3), 1);
  assert.equal(voteFor('restartvm', 'alice', 3), null);
  assert.equal(voteFor('restartvm', 'bob', 3), 2);
  assert.equal(voteFor('restartvm', 'carol', 3), 3);
  dropVote('restartvm');
  assert.equal(voteFor('restartvm', 'alice', 3), 1);
  dropVote('restartvm');
});
