import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = path.join(__dirname, 'settings.json');

const DEFAULT_SETTINGS = {
  colors: {
    ok: 'green',
    warn: 'yellow',
    err: 'darkred',
    info: 'cyan',
    chat: 'auto',
    mod: 'blue',
    owner: 'orange',
  },
  tags: {
    mod: '[Mod]',
    owner: '[Owner]',
  },
  voting: {
    revertVMVoteThreshold: 2,
    restartVMVoteThreshold: 2,
    votebanVoteThreshold: 2,
    votebanDurationSeconds: 300,
  },
  typing: {
    // Max chars for !type / !send text. 0 = no limit (default).
    maxLength: 0,
  },
  livechat: {
    // ms between polls while chat messages are arriving
    fastMs: 700,
    // ms of silence before polling backs off
    idleMs: 10000,
    // max ms between polls while chat is idle
    maxMs: 6000,
    // random jitter fraction added to each poll delay
    jitter: 0.25,
    // transient (429/5xx) retries before giving up
    maxRetries: 12,
    // linear backoff multiplier (ms) for transient failures
    backoffBaseMs: 1500,
  },
};

const ANSI = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  darkred: '\x1b[38;5;88m',
  orange: '\x1b[38;5;208m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
};

const useColor = !!process.stdout.isTTY;
// 24-bit true color when the terminal supports it (Windows Terminal, etc.)
const useTrueColor = useColor && (!!process.env.WT_SESSION ||
  process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit');

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// Stable per-author color: same chatter always gets the same hue.
const authorColors = new Map();
function authorColor(name) {
  if (!authorColors.has(name)) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
    if (useTrueColor) {
      const [r, g, b] = hslToRgb(h, 0.7, 0.55);
      authorColors.set(name, `\x1b[38;2;${r};${g};${b}m`);
    } else {
      authorColors.set(name, `\x1b[3${(h / 360 * 6) | 0}m`);
    }
  }
  return authorColors.get(name);
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      return deepMerge(structuredClone(DEFAULT_SETTINGS), parsed);
    }
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2) + '\n', 'utf8');
  } catch { }
  return structuredClone(DEFAULT_SETTINGS);
}

function deepMerge(base, extra) {
  for (const key of Object.keys(extra || {})) {
    const v = extra[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[key] && typeof base[key] === 'object') {
      deepMerge(base[key], v);
    } else {
      base[key] = v;
    }
  }
  return base;
}

const settings = loadSettings();

const writers = [];
export function setWriter(fn) { writers.push(fn); }

function emit(text) {
  for (const w of writers) w(text);
  if (!writers.length) console.log(text);
}

function paint(name, text) {
  const color = settings.colors[name];
  if (!useColor || !color || !ANSI[color]) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function stamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

export const log = {
  ok(msg) {
    emit(`${stamp()} ${paint('ok', '✓')} ${msg}`);
  },
  warn(msg) {
    emit(`${stamp()} ${paint('warn', 'WARN')} ${msg}`);
  },
  err(msg) {
    emit(`${stamp()} ${paint('err', 'ERR')} ${msg}`);
  },
  info(msg) {
    emit(`${stamp()} ${paint('info', msg)}`);
  },
  chat(msg) {
    // 'auto' mode: color each chatter's name with a stable hue from the
    // 24-bit palette; set colors.chat to a color name for a single color.
    // Optional msg.result ({ text, ok }) is appended as " → <result>" and
    // colored green/red so a merged message+result line reads as one unit.
    if (settings.colors.chat === 'auto' && msg && typeof msg === 'object' && msg.author) {
      const prefix = msg.tag || '';
      const colored = useColor
        ? `${authorColor(msg.author)}@${msg.author}${ANSI.reset}`
        : `@${msg.author}`;
      let result = msg.result ? msg.result.text : '';
      if (result && useColor) {
        result = paint(msg.result.ok ? 'ok' : 'err', result);
      }
      emit(`${stamp()} ${prefix}${colored} : ${msg.message}${result ? ` → ${result}` : ''}`);
      return;
    }
    const text = msg && typeof msg === 'object'
      ? `${msg.tag || ''}@${msg.author} : ${msg.message}${msg.result ? ` → ${msg.result.text}` : ''}`
      : String(msg);
    emit(`${stamp()} ${paint('chat', text)}`);
  },
  plain(msg) {
    emit(msg);
  },
  tag(role) {
    const tag = settings.tags[role];
    const color = settings.colors[role];
    if (!useColor || !tag) return tag || '';
    return `${ANSI[color] || ''}${tag}${ANSI.reset}`;
  },
};

export { settings };

// Dump a buffered line list to logs/<prefix>-<timestamp>.log (shared by the
// CLI session log and the mjsTester tools). Strips ANSI codes.
export function saveLogLines(lines, prefix) {
  if (!lines.length) return null;
  const dir = path.join(__dirname, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${prefix}-${stamp}.log`);
  const clean = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  fs.writeFileSync(file, clean.join('\n') + '\n', 'utf8');
  return file;
}
