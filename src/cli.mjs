#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Bridge } from './bridge.mjs';
import { chordParts, textToGroups, keyNames, burstGroups, presetNames } from './scancodes.mjs';
import { log, setWriter, settings, saveLogLines } from './log.mjs';
import { Terminal } from './prompt.mjs';
import { runLiveLoop } from './livechat.mjs';
import {
  COMMANDS, CHAT_ALLOWED, BARE_COMMANDS, NO_VM_REQUIRED, VOTE_COMMANDS,
  ALIASES, parseChatCommands, buildResult, voteFor, dropVote, buildHelp,
} from './commands.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMPORTS_DIR = path.join(__dirname, '..', 'macros');

const HELP = buildHelp();

// Shadowban state: lowercased author -> expiry timestamp (ms).
const shadowbans = new Map();
function banAuthor(name, seconds) {
  shadowbans.set(name.toLowerCase(), Date.now() + seconds * 1000);
}
function isShadowbanned(name) {
  const key = name.toLowerCase();
  const exp = shadowbans.get(key);
  if (!exp) return false;
  if (exp < Date.now()) { shadowbans.delete(key); return false; }
  return true;
}

// Chat action rate limit: a chatter firing commands faster than RATE_MAX
// messages within RATE_WINDOW gets those actions ignored (spam protection,
// e.g. one user looping !combo win+r ... chains to hold the queue hostage).
// Moderators and the owner bypass the limit.
const RATE_WINDOW_MS = 2000;
const RATE_MAX = 4;
const rateHits = new Map(); // lowercased author -> [timestamps]
function isRateLimited(author, role) {
  if (role === 'moderator' || role === 'owner') return false;
  const key = author.toLowerCase();
  const now = Date.now();
  let hits = rateHits.get(key);
  if (!hits) { hits = []; rateHits.set(key, hits); }
  while (hits.length && now - hits[0] > RATE_WINDOW_MS) hits.shift();
  hits.push(now);
  return hits.length >= RATE_MAX;
}

// Shared cooldown for !restartvm / !revertvm (chat spam protection):
// once either executes, the other is blocked for this long too.
const VM_OP_COOLDOWN_MS = 15000;
let lastVmOpAt = 0;

// Typing speed knobs. Per putScancodes call costs ~12ms, so batching many
// chars per call is the real speed lever (one PDM-queue insert per code, no
// wait). TYPE_DELAY is the gap between bursts INSIDE the bridge (no RTT per
// char anymore). The pipe accepts far more than we send; the only limit is
// the guest's 64-byte PS/2 keyQ when it stalls (see bridge.ps1 Send-Codes
// retry). Measured on this guest: ~160 codes/s sustained DROPS keys; ~50/s
// is safe. 8-char bursts at 35ms ≈ ~170 codes/s - over the old drop point,
// but the bridge retries partial sends instead of silently dropping.
const TYPE_BURST = 8;
const TYPE_DELAY = 35;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bridge = new Bridge();
const term = new Terminal();
setWriter((t) => term.write(t));

// Session log capture: every emitted line is buffered and dumped to logs/
// on exit (Ctrl+C, quit) and on !live stop.
const sessionLines = [];
setWriter((t) => sessionLines.push(t));

function saveSessionLog() {
  try {
    const file = saveLogLines(sessionLines, 'session');
    if (file) term.write(`\nsession log saved: ${file}\n`);
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

// Modifier chords (win+r, ctrl+alt+del, ...) must be sent key-by-key with a
// gap: if the Win make and R make land in the same PS/2 tick, a slow guest
// misses the modifier and the 'r' gets typed as plain text (win+r -> rcmd).
const CHORD_GAP_MS = 60;
async function sendChord(makes, breaks) {
  for (let i = 0; i < makes.length; i++) {
    await sendCodes([makes[i]]);
    if (i < makes.length - 1) await sleep(CHORD_GAP_MS);
  }
  await sleep(120); // hold the chord briefly before releasing
  for (let i = 0; i < breaks.length; i++) {
    await sendCodes([breaks[i]]);
    if (i < breaks.length - 1) await sleep(CHORD_GAP_MS);
  }
}

// Serializes WHOLE command executions (typing streams, combos, macros) so two
// chat commands can never interleave their keystrokes into the guest.
// queueExec(priority=true) inserts at the FRONT of the queue: the next unit
// after the currently running one, so CLI input never waits behind chat spam.
const execTasks = [];
let execRunning = false;
const idleWaiters = [];

function queueExec(fn, priority = false, onCancel) {
  return new Promise((resolve, reject) => {
    const run = () => Promise.resolve().then(fn).then(resolve, reject);
    run.cancel = () => { if (onCancel) onCancel(); resolve(); };
    if (priority) execTasks.unshift(run);
    else execTasks.push(run);
    pump();
  });
}

// Drops all pending queued commands (e.g. chat commands still waiting when
// !live stop arrives). The currently executing command finishes; the rest are
// silently resolved so no caller hangs and nothing runs in the guest.
function clearExecQueue() {
  while (execTasks.length) execTasks.shift().cancel();
}

async function pump() {
  if (execRunning) return;
  execRunning = true;
  try {
    while (execTasks.length) {
      const t = execTasks.shift();
      // Errors are surfaced to the task's own caller (chat/CLI log them);
      // the pump itself must never reject or the queue dies.
      try { await t(); } catch { /* handled by the caller */ }
    }
  } finally {
    execRunning = false;
    for (const r of idleWaiters.splice(0)) r();
  }
}

function whenIdle() {
  if (!execTasks.length && !execRunning) return Promise.resolve();
  return new Promise((r) => idleWaiters.push(r));
}

async function runImport(name, depth = 0) {
  if (depth > 3) throw new Error('import recursion too deep');
  const file = path.join(IMPORTS_DIR, name.endsWith('.txt') ? name : `${name}.txt`);
  if (!fs.existsSync(file)) throw new Error(`no macro '${name}' in macros/`);
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

async function execCommand(text, opts = {}) {
  const match = text.trim().match(/^!([a-zA-Z]+)\s?([\s\S]*)$/);
  if (!match) return { executed: false, hidden: true };
  const typed = match[1].toLowerCase();
  const name = ALIASES[typed] || typed;
  const arg = match[2].trim();
  switch (name) {
    case 'key': {
      const { makes, breaks } = chordParts(arg);
      await sendChord(makes, breaks);
      return { executed: true };
    }
    case 'type': {
      const cap = settings.typing?.maxLength ?? 0;
      if (cap > 0 && arg.length > cap) {
        throw new Error(`!type text is too long (${arg.length} chars, max ${cap})`);
      }
      const bursts = burstGroups(textToGroups(arg), TYPE_BURST);
      await bridge.call('type', { groups: bursts, delay: TYPE_DELAY });
      return { executed: true };
    }
    case 'send': {
      const cap = settings.typing?.maxLength ?? 0;
      if (cap > 0 && arg.length > cap) {
        throw new Error(`!send text is too long (${arg.length} chars, max ${cap})`);
      }
      const groups = textToGroups(arg);
      if (groups.length) groups[groups.length - 1].push(0x1c, 0x9c);
      const bursts = burstGroups(groups, TYPE_BURST);
      await bridge.call('type', { groups: bursts, delay: TYPE_DELAY });
      return { executed: true };
    }
    case 'combo': {
      const { makes, breaks } = chordParts(arg);
      await sendChord(makes, breaks);
      return { executed: true };
    }
    case 'wait': {
      const m = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|seconds|ms|millis)?\s*$/i.exec(arg);
      let ms = m ? parseFloat(m[1]) * (m[2] && /^s/i.test(m[2]) ? 1000 : 1) : NaN;
      const minMs = settings.wait?.minMs ?? 0;
      const maxMs = settings.wait?.maxMs ?? 10000;
      if (!Number.isNaN(ms)) await sleep(Math.min(Math.max(ms, minMs), maxMs));
      return { executed: true };
    }
    case 'startvm': {
      let vm = active;
      if (!vm) {
        const vms = await bridge.call('listMachines');
        const idled = vms.find((v) => v.name && (v.realName || '').toLowerCase() !== 'running');
        vm = (idled || vms.find((v) => v.name) || {}).name;
        if (!vm) throw new Error('no VMs found to start');
      }
      const res = await bridge.call('start', { name: vm }, 240000);
      active = res.name;
      if (!res.launched) {
        log.warn(`${res.name} is already active [${res.stateName}] - nothing to start`);
      } else {
        log.ok(`started ${res.name} [${res.stateName}]`);
      }
      return { executed: true };
    }
    case 'import': {
      await runImport(arg);
      return { executed: true };
    }
    case 'voteban': {
      const target = arg.trim().replace(/^@/, '');
      if (!target) throw new Error('usage: !voteban <author>');
      const dur = settings.voting?.votebanDurationSeconds ?? 300;
      banAuthor(target, dur);
      log.ok(`@${target} is shadowbanned for ${dur}s - will expire in ${dur}s`);
      return { executed: true };
    }
    case 'mouse': {
      const m = /^(up|down|left|right)\s+(?:(\d+(?:\.\d+)?)\s*(s|sec|seconds|ms|millis)?)?$/i.exec(arg);
      if (!m) throw new Error('usage: !mouse <up|down|left|right> [duration]');
      const dir = m[1].toLowerCase();
      let ms = m[2] ? parseFloat(m[2]) * (m[3] && /^s/i.test(m[3]) ? 1000 : 1) : 1000;
      const maxMs = settings.mouse?.maxMs ?? 10000;
      ms = Math.min(Math.max(ms, 250), maxMs);
      await bridge.call('mousemove', { dir, seconds: ms / 1000 });
      return { executed: true };
    }
    case 'lclick': case 'rclick': {
      await bridge.call('mouseclick', { button: typed === 'rclick' ? 'right' : 'left' });
      return { executed: true };
    }
    case 'restartvm': case 'revertvm': {
      // one shared cooldown for both ops: a revert right after a restart is
      // just as disruptive as back-to-back reverts. Chat spam protection
      // only - the CLI operator can always bypass it.
      if (!opts.bypassCooldown) {
        const since = Date.now() - lastVmOpAt;
        if (since < VM_OP_COOLDOWN_MS) {
          throw new Error(`!${typed} is on cooldown - retry in ${Math.ceil((VM_OP_COOLDOWN_MS - since) / 1000)}s`);
        }
      }
      const res = await bridge.call(name === 'restartvm' ? 'restart' : 'revert', {}, 240000);
      lastVmOpAt = Date.now();
      active = res.name;
      // The VM is coming back fresh: any commands that piled up while the op
      // ran would just drain into a brand-new state (or a VM that's mid-boot).
      // Dump them so nothing queued survives a restart/revert.
      clearExecQueue();
      log.ok(`${name === 'restartvm' ? 'restarted' : 'reverted'} ${res.name} [${res.stateName}]`);
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
    if (res.launched) {
      log.info(`launching ${res.name} ... (was powered off)`);
    } else {
      log.warn(`active: ${res.name} [${res.stateName}] - already running`);
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
// Also locks the bridge session so commands actually work after auto-select.
async function ensureActive() {
  if (active) return true;
  try {
    const vms = await bridge.call('listMachines');
    const run = vms.find((v) => v.name && !v.name.startsWith('<') &&
      ((v.realName || '').toLowerCase() === 'running' || v.stateName === 'Running'));
    if (!run) return false;
    await bridge.call('select', { name: run.name });
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
  const author = msg.author.name.replace(/^@/, '');
  // Shadowbanned chatters: message is hidden, nothing executes. They see
  // nothing (shadow) - only the operator sees the expiry note.
  if (isShadowbanned(author)) {
    const left = Math.ceil((shadowbans.get(author.toLowerCase()) - Date.now()) / 1000);
    log.warn(`@${author} is shadowbanned - will expire in ${left}s`);
    return;
  }
  const cmds = parseChatCommands(msg.message);
  const targets = [];
  for (const c of cmds) {
    const name = c.cmd.slice(1).toLowerCase();
    if (name === 'clearLog') continue;
    if (VOTE_COMMANDS.has(name)) continue;
    if (!CHAT_ALLOWED.has(name)) continue;
    targets.push(`${c.cmd} ${c.args.join(' ')}`.trim());
  }
  const needsVM = targets.some((t) => !NO_VM_REQUIRED.has(t.slice(1).split(/\s+/)[0].toLowerCase()));
  // Command messages are rendered once when their chain finishes - message
  // and result glued together on one line.
  const render = (result) => {
    const tag = msg.role === 'owner' ? log.tag('owner')
      : msg.role === 'moderator' ? log.tag('mod') : '';
    log.chat({ tag: tag ? `${tag} ` : '', author, message: msg.message, result });
  };
  if (!cmds.length) {
    render(null);
    return;
  }
  if (isRateLimited(author, msg.role)) {
    render({ text: '✗ rate-limited - action ignored', ok: false });
    return;
  }
  if (!targets.length) {
    // Vote-only / unknown commands: plain render, the vote loop below handles them.
    render(null);
  } else {
    // One whole message's command chain executes as a single serialized unit,
    // so concurrent chatters can never interleave keystrokes in the guest.
    queueExec(async () => {
      if (needsVM && !(await ensureActive())) {
        render({ text: `✗ no running VM - ${targets.length} command(s) ignored`, ok: false });
        return;
      }
      const t0 = Date.now();
      const badges = [];
      let ok = 0;
      for (const cmdText of targets) {
        try {
          await execCommand(cmdText);
          ok++;
          badges.push(`[✓ ${cmdText}]`);
        } catch (err) {
          const isVmOff = /Powered off|start it first/i.test(err.message);
          badges.push(`[✗ ${cmdText}: ${err.message}]`);
          // VM being powered off fails every remaining command identically -
          // stop the chain and skip them.
          if (isVmOff) break;
        }
      }
      const ms = Date.now() - t0;
      const skipped = targets.length - badges.length;
      render(buildResult(msg.message, author, badges, ok, targets.length, ms, skipped));
    }, false, () => render({ text: '✗ cancelled - queue cleared', ok: false }));
  }
  // Vote-gated commands: count votes immediately (not queued), execute only
  // once enough distinct chatters have asked within the vote window.
  for (const c of cmds) {
    const typedName = c.cmd.slice(1).toLowerCase();
    const name = ALIASES[typedName] || typedName;
    if (!VOTE_COMMANDS.has(name)) continue;
    if (name === 'voteban') {
      const target = c.args.join(' ').trim().replace(/^@/, '');
      if (!target) {
        log.warn('usage: !voteban <author>');
        continue;
      }
      const threshold = settings.voting?.votebanVoteThreshold ?? 2;
      const vkey = `voteban:${target.toLowerCase()}`;
      const n = voteFor(vkey, author, threshold);
      if (n === null) continue;
      log.info(n === 1
        ? `[VOTE-BAN] @${author} started !voteban @${target}, vote ${n}/${threshold}`
        : `[VOTE-BAN] @${author} voted !voteban @${target}, vote ${n}/${threshold}`);
      if (n < threshold) continue;
      dropVote(vkey);
      const dur = settings.voting?.votebanDurationSeconds ?? 300;
      banAuthor(target, dur);
      log.ok(`@${target} is shadowbanned for ${dur}s - will expire in ${dur}s`);
      continue;
    }
    const threshold = settings.voting?.[COMMANDS[name].thresholdKey] ?? 2;
    const n = voteFor(name, author, threshold);
    if (n === null) continue;
    const vtag = `[VOTE-${name.toUpperCase()}]`;
    log.info(n === 1
      ? `${vtag} @${author} started !${typedName}, vote ${n}/${threshold}`
      : `${vtag} @${author} voted !${typedName}, vote ${n}/${threshold}`);
    if (n < threshold) continue;
    dropVote(name);
    log.ok(`${vtag} !${typedName} triggered by ${n} votes`);
    const t0 = Date.now();
    // Priority lane: a vote-passed VM op must not wait behind a backlog of
    // typing spam (that's the 12-minute lag from the logs) - it jumps the
    // queue, then execCommand dumps whatever is still queued behind it.
    queueExec(async () => {
      if (!(await ensureActive())) {
        log.warn(`no running VM - !${typedName} ignored`);
        return;
      }
      try {
        await execCommand(`!${name}`);
        log.ok(`Executed : "!${typedName}" Time: ${Date.now() - t0}ms`);
      } catch (err) {
        log.err(`Failed : "!${typedName}": ${err.message}`);
      }
    }, true);
  }
}

async function cmdLive(arg) {
  if (arg === 'stop') {
    if (liveAbort) {
      liveAbort();
      liveAbort = null;
      clearExecQueue();
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
  runLiveLoop(arg, onChatMessage, () => aborted, (title, host) => {
    const stream = title || host;
    log.ok(stream
      ? `[Live Chat Connected] (Host : [${stream}])`
      : '[Live Chat Connected]');
  })
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
        term.write('usage: !key <key>   e.g. !key enter - !key ctrl+alt+del - !key tty2 - !key ? = keys & linux presets');
        return;
      }
      if (arg === '?') {
        term.write('supported keys:\n  ' + keyNames().join(' ') + '\n\nlinux presets:\n  ' + presetNames().join(' '));
        return;
      }
    }
    if (!active && CHAT_ALLOWED.has(name) && !NO_VM_REQUIRED.has(name)) {
      if (!(await ensureActive())) {
        log.warn('no running VM - pick one with list');
        return;
      }
    }
    try {
      const t0 = Date.now();
      log.info(`Executing : "[CLI] ${line}"`);
      await queueExec(async () => {
        const cmds = parseChatCommands(line);
        if (cmds.length <= 1) {
          await execCommand(line, { bypassCooldown: true });
        } else {
          for (const c of cmds) {
            await execCommand(`${c.cmd} ${c.args.join(' ')}`.trim(), { bypassCooldown: true });
          }
        }
      }, true);
      log.ok(`Executed : "[CLI] ${line}" Time: ${Date.now() - t0}ms`);
    } catch (err) {
      log.err(err.message);
    }
    return;
  }
  // Bare command names: `!` is optional for exec commands at the prompt
  // (chat still requires it so plain messages stay chat).
  const [word, ...cmdArgs] = line.split(/\s+/);
  const bare = (word || '').toLowerCase();
  if (BARE_COMMANDS.has(bare)) {
    if (bare === 'live') return cmdLive(cmdArgs.join(' '));
    if (bare === 'clearLog') return term.clear();
    if (bare === 'start' || bare === 'startvm') {
      if (!cmdArgs[0] && !active) { log.warn('no active VM - use list or start <name>'); return; }
      return setActive(cmdArgs[0] || active);
    }
    if (bare === 'key') {
      const arg = cmdArgs.join(' ');
      if (!arg) {
        term.write('usage: key <key>   e.g. key enter - key ctrl+alt+del - key tty2 - key ? = keys & linux presets');
        return;
      }
      if (arg === '?') {
        term.write('supported keys:\n  ' + keyNames().join(' ') + '\n\nlinux presets:\n  ' + presetNames().join(' '));
        return;
      }
    }
    if (!active && CHAT_ALLOWED.has(bare)) {
      if (!(await ensureActive())) {
        log.warn('no running VM - pick one with list');
        return;
      }
    }
    try {
      const t0 = Date.now();
      const lineWithBang = '!' + line;
      log.info(`Executing : "[CLI] ${lineWithBang}"`);
      await queueExec(async () => {
        const cmds = parseChatCommands(lineWithBang);
        if (cmds.length <= 1) {
          await execCommand(lineWithBang, { bypassCooldown: true });
        } else {
          for (const c of cmds) {
            await execCommand(`${c.cmd} ${c.args.join(' ')}`.trim(), { bypassCooldown: true });
          }
        }
      }, true);
      log.ok(`Executed : "[CLI] ${lineWithBang}" Time: ${Date.now() - t0}ms`);
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
      const line = await term.prompt(`${active ? `[${active}] ` : ''}> `);
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

export { execCommand, setActive, onChatMessage, parseChatCommands, whenIdle };
