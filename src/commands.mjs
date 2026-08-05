// Command registry and pure chat/CLI command helpers.
//
// Single source of truth for what commands exist and how they behave:
// which may run from live chat, which work without the `!` prefix at the
// prompt, which need a running VM, and which are vote-gated. The HELP text
// is generated from this registry, so the docs can't drift from the code.
// Everything here is side-effect free so it can be unit-tested directly.

// Per-command flags:
//   chat         - allowed from YouTube live chat
//   bare         - `!` prefix is optional at the CLI prompt
//   prompt       - only usable via the CLI switch dispatcher (never as !cmd)
//   vm: false    - works even when every VM is powered off
//   vote         - vote-gated in chat (N distinct chatters in the window)
//   aliasOf      - canonical command this name is an alias of
//   thresholdKey - settings.voting key for the chat vote threshold
//   help         - verbatim line rendered in the HELP text
export const COMMANDS = {
  list: {
    prompt: true,
    help: '  list             VM picker (arrows + Enter) - auto-starts if powered off',
  },
  info: {
    prompt: true,
    help: '  info [<name>]    show VM details',
  },
  pause: {
    prompt: true,
    help: '  pause | resume   pause / resume the active VM',
  },
  stop: {
    prompt: true,
    help: '  stop             power off the active VM (ACPI)',
  },
  key: {
    chat: true, bare: true,
    help: '  key <key>        send a key:  key enter - key ctrl+alt+del - key tty2 - key ? = keys & linux presets',
  },
  type: {
    chat: true, bare: true,
    help: '  type <text>      type text into the VM (no Enter)',
  },
  send: {
    chat: true, bare: true,
    help: '  send <text>      type text and press Enter (alias: sendm)',
  },
  sendm: {
    chat: true, bare: true, aliasOf: 'send',
  },
  combo: {
    chat: true, bare: true,
    help: '  combo <chord>    key combo with hold:  combo win+r',
  },
  wait: {
    chat: true, bare: true,
    help: '  wait <dur>       pause:  500ms, 2s, 3 (ms) - max 10s',
  },
  mouse: {
    chat: true, bare: true,
    help: '  mouse <dir>      drift cursor:  mouse up 4s - mouse left 2s (max 10s)',
  },
  lclick: {
    chat: true, bare: true,
    help: '  lclick|rclick    click left/right mouse button at current cursor',
  },
  rclick: {
    chat: true, bare: true,
    help: '  rclick           right mouse button at current cursor',
  },
  import: {
    chat: true, bare: true,
    help: '  import <name>    run a macro from macros/  (e.g. import this)',
  },
  startvm: {
    chat: true, bare: true, vm: false,
    help: '  startvm          start / activate a VM (also: start <name>, alias: start)',
  },
  start: {
    bare: true, vm: false, aliasOf: 'startvm',
  },
  revertvm: {
    chat: true, bare: true, vote: true, thresholdKey: 'revertVMVoteThreshold',
    help: '  revertvm         revert to latest snapshot (chat: N votes to trigger, alias: revert)',
  },
  revert: {
    bare: true, aliasOf: 'revertvm',
  },
  restartvm: {
    chat: true, bare: true, vote: true, thresholdKey: 'restartVMVoteThreshold',
    help: '  restartvm        restart the VM (chat: N votes to trigger, alias: restart)',
  },
  restart: {
    bare: true, aliasOf: 'restartvm',
  },
  voteban: {
    bare: true, vote: true,
    help: '  voteban <author> shadowban a chatter (chat: N votes to trigger)',
  },
  live: {
    bare: true, vm: false,
    help: '  live <videoId>   connect YouTube live chat - live stop to disconnect',
  },
  clearLog: {
    bare: true, vm: false,
    help: '  clearLog         clear the console',
  },
  help: {
    help: '  help | ?         this help - exit | quit',
  },
};

// Derived sets: identical to what cli.mjs hand-maintained before the
// registry existed. Derived so adding a command flag here propagates
// everywhere automatically.
export const CHAT_ALLOWED = new Set();
export const BARE_COMMANDS = new Set();
export const NO_VM_REQUIRED = new Set();
export const VOTE_COMMANDS = new Set();
export const ALIASES = {}; // alias name -> canonical command name

for (const [name, def] of Object.entries(COMMANDS)) {
  if (def.chat) CHAT_ALLOWED.add(name);
  if (def.bare) BARE_COMMANDS.add(name);
  if (def.vm === false) NO_VM_REQUIRED.add(name);
  if (def.vote) VOTE_COMMANDS.add(name);
  if (def.aliasOf) ALIASES[name] = def.aliasOf;
}

// HELP order matches the original static help text (aliases are documented
// inline on their canonical command's line, so they aren't listed twice).
const HELP_ORDER = ['list', 'info', 'pause', 'stop', 'key', 'type', 'send',
  'combo', 'wait', 'mouse', 'lclick', 'import', 'startvm',
  'revertvm', 'restartvm', 'voteban', 'live', 'clearLog', 'help'];

const HELP_HEADER = 'Commands: (! optional at this prompt - chat requires it)';

export function buildHelp() {
  const lines = HELP_ORDER.map((n) => COMMANDS[n]?.help ?? `  ${n}`);
  return `${HELP_HEADER}\n${lines.join('\n')}`;
}

// Splits a chat message into its `!command` chain. Plain text between
// commands is ignored: '!key enter then !wait 2s' -> two commands.
export function parseChatCommands(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const cmds = [];
  let cur = null;
  for (const t of tokens) {
    if (t.startsWith('!')) {
      if (cur) cmds.push(cur);
      cur = { cmd: t, args: [] };
    } else if (cur) {
      cur.args.push(t);
    }
  }
  if (cur) cmds.push(cur);
  return cmds;
}

// Merged message+result line: chat line and outcome in one, so a busy chat
// can never leave a result floating under the wrong message. Full per-command
// badges when the line stays readable, count+failures when it would get too
// long (long !type chains).
const MAX_RESULT_LINE = 150;
export function buildResult(message, author, badges, ok, total, ms, skipped) {
  const allOk = ok === badges.length;
  const line = (r) => `@${author} : ${message} → ${r}`;
  const actions = (n) => `${n} action${n === 1 ? '' : 's'}`;
  const full = allOk
    ? `${badges.join(' ')} - ${actions(badges.length)} in ${ms}ms`
    : `${badges.join(' ')} - ${ok}/${total} in ${ms}ms${skipped ? ` (${skipped} skipped)` : ''}`;
  if (line(full).length <= MAX_RESULT_LINE) return { text: full, ok: allOk };
  if (allOk) return { text: `✓ ${ok}/${total} in ${ms}ms`, ok: true };
  let fails = badges.filter((b) => b.startsWith('[✗'))
    .map((b) => b.slice(3, -1))
    .filter((v, i, a) => a.indexOf(v) === i)
    .join('; ');
  if (fails.length > 90) fails = fails.slice(0, 90) + '…';
  return {
    text: `✗ ${ok}/${total}${skipped ? ` (${skipped} skipped)` : ''} in ${ms}ms${fails ? ` - ${fails}` : ''}`,
    ok: false,
  };
}

// Vote state for vote-gated chat commands (!revertvm / !restartvm / !voteban):
// N distinct chatters must request the same command within VOTE_WINDOW ms.
export const VOTE_WINDOW = 60000;
const votes = new Map();

export function voteFor(name, author, threshold) {
  const now = Date.now();
  let v = votes.get(name);
  if (!v || v.until < now) {
    v = { by: new Set(), until: now + VOTE_WINDOW };
    votes.set(name, v);
  }
  if (v.by.has(author)) return null;
  v.by.add(author);
  return v.by.size;
}

// Clears a vote that already reached its threshold and executed.
export function dropVote(name) {
  votes.delete(name);
}
