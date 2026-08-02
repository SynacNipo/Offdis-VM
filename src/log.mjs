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
    chat: 'gray',
    mod: 'blue',
    owner: 'orange',
  },
  tags: {
    mod: '[Mod]',
    owner: '[Owner]',
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
    emit(`${stamp()} ${paint('chat', msg)}`);
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
  color: paint,
};

export { settings };
