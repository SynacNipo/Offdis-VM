function S(make, brk) {
  make = Array.isArray(make) ? make : [make];
  brk = brk ? (Array.isArray(brk) ? brk : [brk]) : make.map((b) => b | 0x80);
  return { make, brk };
}

export const KEY = {
  esc: S(0x01),
  '1': S(0x02), '2': S(0x03), '3': S(0x04), '4': S(0x05), '5': S(0x06),
  '6': S(0x07), '7': S(0x08), '8': S(0x09), '9': S(0x0A), '0': S(0x0B),
  minus: S(0x0C), equals: S(0x0D), backspace: S(0x0E), tab: S(0x0F),
  q: S(0x10), w: S(0x11), e: S(0x12), r: S(0x13), t: S(0x14), y: S(0x15),
  u: S(0x16), i: S(0x17), o: S(0x18), p: S(0x19),
  lbracket: S(0x1A), rbracket: S(0x1B), enter: S(0x1C),
  ctrl: S(0x1D),
  a: S(0x1E), s: S(0x1F), d: S(0x20), f: S(0x21), g: S(0x22), h: S(0x23),
  j: S(0x24), k: S(0x25), l: S(0x26),
  semicolon: S(0x27), quote: S(0x28), backtick: S(0x29), shift: S(0x2A),
  backslash: S(0x2B),
  z: S(0x2C), x: S(0x2D), c: S(0x2E), v: S(0x2F), b: S(0x30), n: S(0x31), m: S(0x32),
  comma: S(0x33), period: S(0x34), slash: S(0x35), rshift: S(0x36),
  alt: S(0x38), space: S(0x39), caps: S(0x3A),
  f1: S(0x3B), f2: S(0x3C), f3: S(0x3D), f4: S(0x3E), f5: S(0x3F),
  f6: S(0x40), f7: S(0x41), f8: S(0x42), f9: S(0x43), f10: S(0x44),
  numlock: S(0x45), scrolllock: S(0x46),
  np7: S(0x47), np8: S(0x48), np9: S(0x49), npminus: S(0x4A), np4: S(0x4B),
  np5: S(0x4C), np6: S(0x4D), npplus: S(0x4E), np1: S(0x4F), np2: S(0x50),
  np3: S(0x51), np0: S(0x52), npdot: S(0x53),
  f11: S(0x57), f12: S(0x58),
  rctrl: S([0xE0, 0x1D]), ralt: S([0xE0, 0x38]),
  up: S([0xE0, 0x48]), down: S([0xE0, 0x50]), left: S([0xE0, 0x4B]), right: S([0xE0, 0x4D]),
  home: S([0xE0, 0x47]), end: S([0xE0, 0x4F]), pgup: S([0xE0, 0x49]), pgdn: S([0xE0, 0x51]),
  insert: S([0xE0, 0x52]), delete: S([0xE0, 0x53]),
  win: S([0xE0, 0x5B]), rwin: S([0xE0, 0x5C]), menu: S([0xE0, 0x5D]),
  prtsc: S([0xE0, 0x2A, 0xE0, 0x37], [0xE0, 0xB7, 0xE0, 0xAA]),
};

export const ALIAS = {
  return: 'enter', ret: 'enter', escape: 'esc', spc: 'space', bksp: 'backspace',
  control: 'ctrl', lctrl: 'ctrl', lshift: 'shift', lalt: 'alt',
  rcontrol: 'rctrl', altgr: 'ralt', del: 'delete', ins: 'insert',
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
  capslock: 'caps', pageup: 'pgup', pagedown: 'pgdn',
  printscreen: 'prtsc', printscr: 'prtsc', apps: 'menu',
  lwin: 'win', super: 'win', hyphen: 'minus', dash: 'minus', equal: 'equals',
  grave: 'backtick', tilde: 'backtick', apostrophe: 'quote',
  '[': 'lbracket', ']': 'rbracket', '\\': 'backslash', '.': 'period', ',': 'comma',
  '/': 'slash', ';': 'semicolon', "'": 'quote', '-': 'minus', '=': 'equals', '`': 'backtick',
  numpad0: 'np0', numpad1: 'np1', numpad2: 'np2', numpad3: 'np3', numpad4: 'np4',
  numpad5: 'np5', numpad6: 'np6', numpad7: 'np7', numpad8: 'np8', numpad9: 'np9',
  numpadminus: 'npminus', numpadplus: 'npplus', numpaddot: 'npdot',
};

export function chordParts(chord) {
  const parts = chord.trim().toLowerCase().split(/[+-]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('no key given');
  const keys = [];
  for (const p of parts) {
    const k = ALIAS[p] || p;
    if (!KEY[k]) throw new Error(`unknown key '${p}' (see \`!key ?\`)`);
    keys.push(KEY[k]);
  }
  const makes = [];
  const breaks = [];
  for (const k of keys) makes.push(...k.make);
  for (let i = keys.length - 1; i >= 0; i--) breaks.push(...keys[i].brk);
  return { makes, breaks };
}

export function resolveKey(chord) {
  const { makes, breaks } = chordParts(chord);
  return [...makes, ...breaks];
}

const SHIFT_CHARS = {
  '~': 'backtick', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6',
  '&': '7', '*': '8', '(': '9', ')': '0', '_': 'minus', '+': 'equals',
  '{': 'lbracket', '}': 'rbracket', '|': 'backslash', ':': 'semicolon',
  '"': 'quote', '<': 'comma', '>': 'period', '?': 'slash',
};

const PLAIN_CHARS = {
  '-': 'minus', '=': 'equals', '[': 'lbracket', ']': 'rbracket', '\\': 'backslash',
  ';': 'semicolon', "'": 'quote', '`': 'backtick', ',': 'comma', '.': 'period',
  '/': 'slash', ' ': 'space', '\t': 'tab', '\n': 'enter', '\r': 'enter',
};

export function textToGroups(text) {
  const groups = [];
  let shiftHeld = false;
  for (const ch of String(text)) {
    let keyName = null;
    let needsShift = false;
    if (/[a-z]/.test(ch)) keyName = ch;
    else if (/[A-Z]/.test(ch)) { keyName = ch.toLowerCase(); needsShift = true; }
    else if (/[0-9]/.test(ch)) keyName = ch;
    else if (SHIFT_CHARS[ch] !== undefined) { keyName = SHIFT_CHARS[ch]; needsShift = true; }
    else if (PLAIN_CHARS[ch] !== undefined) keyName = PLAIN_CHARS[ch];
    if (!keyName) {
      throw new Error(`cannot type character '${ch}' (0x${ch.codePointAt(0).toString(16)})`);
    }
    const k = KEY[keyName];
    const codes = [];
    if (needsShift && !shiftHeld) { codes.push(...KEY.shift.make); shiftHeld = true; }
    if (!needsShift && shiftHeld) { codes.push(...KEY.shift.brk); shiftHeld = false; }
    codes.push(...k.make, ...k.brk);
    groups.push(codes);
  }
  if (shiftHeld && groups.length) groups[groups.length - 1].push(...KEY.shift.brk);
  return groups;
}

export function textToCodes(text) {
  return textToGroups(text).flat();
}

export function keyNames() {
  return Object.keys(KEY).sort();
}
