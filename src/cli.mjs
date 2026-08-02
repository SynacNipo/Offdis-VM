#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Bridge } from './bridge.mjs';
import { resolveKey, chordParts, textToGroups, textToCodes, keyNames } from './scancodes.mjs';
import { log, setWriter } from './log.mjs';
import { Terminal } from './prompt.mjs';
import { runLiveLoop } from './livechat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMPORTS_DIR = path.join(__dirname, 'imports');

const HELP = `Commands:
  list             VM picker (arrows + Enter) - auto-starts if powered off
  info [<name>]    show VM details
  pause | resume   pause / resume the active VM
  stop             power off the active VM (ACPI)
  !key <key>       send a key:  !key enter - !key ctrl+alt+del - !key ? = all keys
  !type <text>     type text into the VM (no Enter)
  !send <text>     type text and press Enter
  !combo <chord>   key combo with hold:  !combo win+r
  !import <name>   run a macro from imports/  (e.g. !import this)
  !live <videoId>  connect YouTube live chat - !live stop to disconnect
  !clearLog        clear the console
  help | ?         this help - exit | quit`;

const CHAT_ALLOWED = new Set(['key', 'type', 'send', 'combo', 'import']);

// Typing speed knobs. Per putScancodes call costs ~12ms; consecutive
// shift-free chars are merged into small bursts to amortize that. TYPE_DELAY
// is the gap between bursts INSIDE the bridge (no RTT per char anymore).
// Measured on this guest: ~160 codes/s sustained DROPS keys; ~50/s is safe.
const TYPE_BURST = 2;
const TYPE_DELAY = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bridge = new Bridge();
const term = new Terminal();
setWriter((t) => term.write(t));

// Session log capture: every emitted line is buffered and dumped to logs/
// on exit (Ctrl+C, quit) and on !live stop.
const LOG_DIR = path.join(__dirname, 'logs');
const sessionLines = [];
setWriter((t) => sessionLines.push(t));

function saveSessionLog() {
  try {
    if (!sessionLines.length) return;
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(LOG_DIR, `session-${stamp}.log`);
    fs.writeFileSync(file, sessionLines.join('\n') + '\n', 'utf8');
    term.write(`\nsession log saved: ${file}\n`);
  } catch (err) {
    term.write(`\nfailed to save session log: ${err.message}\n`);
  }
}

let active = null;

let inputQueue = Promise.resolve();
function queued(fn) {
  const p = inputQueue.then(fn, fn);
  inputQueue = p.catch(() => { });
  return p;
}

async function sendCodes(codes) {
  await queued(() => bridge.call('key', { codes }));
}

// Serializes WHOLE command executions (typing streams, combos, macros) so two
// chat commands can never interleave their keystrokes into the guest.
let execQueue = Promise.resolve();
function queueExec(fn) {
  const p = execQueue.then(fn, fn);
  execQueue = p.catch(() => { });
  return p;
}
function whenIdle() { return execQueue; }

function parseChatCommands(text) {
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

async function runImport(name, depth = 0) {
  if (depth > 3) throw new Error('import recursion too deep');
  const file = path.join(IMPORTS_DIR, name.endsWith('.txt') ? name : `${name}.txt`);
  if (!fs.existsSync(file)) throw new Error(`no macro '${name}' in imports/`);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!import')) {
      await runImport(line.slice(7).trim(), depth + 1);
    } else {
      await execCommand(line);
    }
  }
}

// Merge consecutive shift-free chars into bursts of <= max chars (their codes
// are independent [make,break] pairs). Shift groups stay alone so the shift
// press/release order inside a char is never disturbed.
function burstGroups(groups, max) {
  const bursts = [];
  let cur = [];
  let n = 0;
  for (const g of groups) {
    const shift = g.length > 2;
    if (n > 0 && (shift || n >= max)) { bursts.push(cur); cur = []; n = 0; }
    cur.push(...g);
    n++;
    if (!shift && n >= max) { bursts.push(cur); cur = []; n = 0; }
  }
  if (cur.length) bursts.push(cur);
  return bursts;
}

async function execCommand(text) {
  const match = text.trim().match(/^!([a-zA-Z]+)\s?([\s\S]*)$/);
  if (!match) return { executed: false, hidden: true };
  const name = match[1].toLowerCase();
  const arg = match[2].trim();
  switch (name) {
    case 'key': {
      await sendCodes(resolveKey(arg));
      return { executed: true };
    }
    case 'type': {
      const bursts = burstGroups(textToGroups(arg), TYPE_BURST);
      await bridge.call('type', { groups: bursts, delay: TYPE_DELAY });
      return { executed: true };
    }
    case 'send': {
      const groups = textToGroups(arg);
      if (groups.length) groups[groups.length - 1].push(0x1c, 0x9c);
      const bursts = burstGroups(groups, TYPE_BURST);
      await bridge.call('type', { groups: bursts, delay: TYPE_DELAY });
      return { executed: true };
    }
    case 'combo': {
      const { makes, breaks } = chordParts(arg);
      try {
        await sendCodes(makes);
        await sleep(120);
      } finally {
        await sendCodes(breaks);
      }
      return { executed: true };
    }
    case 'wait': {
      const ms = parseInt(arg, 10);
      if (!Number.isNaN(ms)) await sleep(Math.min(Math.max(ms, 0), 10000));
      return { executed: true };
    }
    case 'import': {
      await runImport(arg);
      return { executed: true };
    }
    default:
      throw new Error(`unknown command '!${name}'`);
  }
}

async function setActive(name) {
  try {
    const res = await bridge.call('start', { name });
    active = res.name;
    if (res.state === 1) {
      log.info(`launching ${res.name} ... (was powered off)`);
    } else {
      log.ok(`active: ${res.name} [${res.stateName}]`);
    }
  } catch (err) {
    log.err(`failed: ${err.message}`);
  }
}

function printTable(vms) {
  const rows = vms.map((v) => ({
    NAME: v.name || '(unknown)',
    STATE: v.stateName || String(v.state),
    ID: (v.id || '').slice(0, 8),
  }));
  if (!rows.length) { log.warn('no VMs registered'); return; }
  const widths = {};
  for (const c of Object.keys(rows[0])) {
    widths[c] = Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length));
  }
  const pad = (s, n) => String(s).padEnd(n);
  log.plain(rows.map((r) => `${pad(r.NAME, widths.NAME)}  ${pad(r.STATE, widths.STATE)}  ${pad(r.ID, widths.ID)}`).join('\n'));
}

async function cmdList() {
  let vms;
  try {
    vms = await bridge.call('listMachines');
  } catch (err) {
    log.err(`failed: ${err.message}`);
    return;
  }
  const usable = vms.filter((v) => v.name && !v.name.startsWith('<'));
  if (!usable.length) { log.warn('no VMs available'); return; }
  if (!process.stdin.isTTY) { printTable(vms); return; }
  const picked = await term.menu(
    'Select Virtual Machine to set as active',
    usable.map((v) => v.name),
    '(arrows move - Enter select - Esc cancel)',
  );
  if (!picked) return;
  await setActive(picked);
}

async function cmdInfo(name) {
  const target = name || active;
  if (!target) { log.warn('usage: info <vm name>'); return; }
  try {
    const i = await bridge.call('info', { name: target });
    log.plain(`Name:     ${i.name}`);
    log.plain(`UUID:     ${i.id}`);
    log.plain(`State:    ${i.stateName}${i.realName ? ` (${i.realName})` : ''}`);
    log.plain(`Memory:   ${i.memoryMB} MB`);
    log.plain(`CPUs:     ${i.vcpu}`);
    log.plain(`OS type:  ${i.os}`);
    if (i.snapshot) log.plain(`Snapshot: ${i.snapshot}`);
  } catch (err) { log.err(`failed: ${err.message}`); }
}

async function cmdPauseResume(op, word) {
  if (!active) { log.warn('no active VM - pick one with list'); return; }
  try {
    await bridge.call(op);
    log.ok(`${word} ${active}`);
  } catch (err) { log.err(`failed: ${err.message}`); }
}

// If no VM is active, auto-select the first running one so chat commands
// don't get dropped just because the picker was skipped.
async function ensureActive() {
  if (active) return true;
  try {
    const vms = await bridge.call('listMachines');
    const run = vms.find((v) => v.name && !v.name.startsWith('<') &&
      ((v.realName || '').toLowerCase() === 'running' || v.stateName === 'Running'));
    if (!run) return false;
    active = run.name;
    log.ok(`auto-selected: ${run.name} [${run.stateName}]`);
    return true;
  } catch {
    return false;
  }
}

// ---- live chat ----
let liveAbort = null;

function onChatMessage(msg) {
  const tag = msg.role === 'owner' ? log.tag('owner')
    : msg.role === 'moderator' ? log.tag('mod') : '';
  const author = msg.author.name.replace(/^@/, '');
  log.chat(`${tag ? `${tag} ` : ''}@${author} : ${msg.message}`);
  const cmds = parseChatCommands(msg.message);
  if (!cmds.length) return;
  // One whole message's command chain executes as a single serialized unit,
  // so concurrent chatters can never interleave keystrokes in the guest.
  queueExec(async () => {
    if (!(await ensureActive())) {
      log.warn('no running VM - chat commands ignored');
      return;
    }
    for (const c of cmds) {
      const name = c.cmd.slice(1).toLowerCase();
      if (name === 'clearLog') continue;
      if (!CHAT_ALLOWED.has(name)) continue;
      const cmdText = `${c.cmd} ${c.args.join(' ')}`.trim();
      const t0 = Date.now();
      log.info(`Executing : "${cmdText}"`);
      try {
        await execCommand(cmdText);
        log.ok(`Executed : "${cmdText}" by @${author}, Time: ${Date.now() - t0}ms`);
      } catch (err) {
        log.err(`Failed : "${cmdText}" by @${author}: ${err.message}`);
      }
    }
  });
}

async function cmdLive(arg) {
  if (arg === 'stop') {
    if (liveAbort) {
      liveAbort();
      liveAbort = null;
      log.info('stopping live chat...');
      saveSessionLog();
    } else {
      log.warn('live chat is not running');
    }
    return;
  }
  if (!arg) { log.warn('usage: !live <videoId>'); return; }
  if (liveAbort) { log.warn('already connected - !live stop to disconnect'); return; }
  let aborted = false;
  liveAbort = () => { aborted = true; };
  log.info(`connecting to live stream ${arg} ...`);
  runLiveLoop(arg, onChatMessage, () => aborted)
    .then(() => {
      liveAbort = null;
      log.info('live chat disconnected');
    })
    .catch((err) => {
      liveAbort = null;
      log.err(`live chat: ${err.message}`);
    });
}

// ---- command dispatch ----
async function handle(line) {
  if (!line) return;
  const low = line.toLowerCase();
  if (low === 'exit' || low === 'quit' || low === 'q') return shutdown();
  if (low === 'help' || low === '?') return term.write(HELP);
  if (line.startsWith('!')) {
    const name = line.slice(1).split(/\s+/)[0].toLowerCase();
    if (name === 'clearLog') return term.clear();
    if (name === 'live') return cmdLive(line.slice(5).trim());
    if (name === 'key') {
      const arg = line.slice(4).trim();
      if (!arg) {
        term.write('usage: !key <key>   e.g. !key enter - !key ctrl+alt+del - !key ? = all keys');
        return;
      }
      if (arg === '?') {
        term.write('supported keys:\n  ' + keyNames().join(' '));
        return;
      }
    }
    if (!active && CHAT_ALLOWED.has(name)) {
      if (!(await ensureActive())) {
        log.warn('no running VM - pick one with list');
        return;
      }
    }
    try {
      await queueExec(() => execCommand(line));
      log.ok(line);
    } catch (err) {
      log.err(err.message);
    }
    return;
  }
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case 'list': case 'ls': return cmdList();
    case 'info': case 'state': return cmdInfo(arg);
    case 'pause': return cmdPauseResume('pause', 'paused');
    case 'resume': return cmdPauseResume('resume', 'resumed');
    case 'stop': return cmdPauseResume('stop', 'power-off');
    default:
      log.warn(`unknown command '${cmd}' - type help`);
  }
}

async function shutdown() {
  saveSessionLog();
  try { await bridge.close(); } catch { }
  term.close();
  process.exit(0);
}

export async function connect() {
  try {
    await bridge.connect();
  } catch (err) {
    log.err(`bridge failed: ${err.message}`);
    process.exit(1);
  }
  log.ok(`VirtualBox ${bridge.version} (COM revision ${bridge.apiRevision})`);
}

async function main() {
  if (!fs.existsSync(IMPORTS_DIR)) fs.mkdirSync(IMPORTS_DIR, { recursive: true });
  await connect();

  if (process.stdin.isTTY) {
    term.start();
    while (true) {
      const line = await term.prompt(`vbox${active ? ` [${active}]` : ''}> `);
      if (line === null) break;
      await handle(line.trim());
    }
  } else {
    process.stdin.setEncoding('utf8');
    let buf = '';
    for await (const chunk of process.stdin) {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        await handle(line.trim());
      }
    }
    if (buf.trim()) await handle(buf.trim());
  }
  await shutdown();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

export { execCommand, setActive, onChatMessage, parseChatCommands, handle, whenIdle };
