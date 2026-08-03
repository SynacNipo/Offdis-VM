// Zero-dependency raw-mode terminal: line prompt, history, async output
// interleaving, and an arrow-key menu. Replaces node:readline so live chat
// output can print safely while the user is typing.

const ESC = 0x1b;

export class Terminal {
  constructor() {
    this.buf = '';
    this.history = [];
    this.hIndex = 0;
    this.promptText = '';
    this.waiting = null;
    this.esc = 0;
    this.menuState = null;
    this.closed = false;
  }

  start() {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => this.onData(d));
  }

  close() {
    this.closed = true;
    if (process.stdin.isRaw) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.removeAllListeners('data');
  }

  onData(chunk) {
    for (const ch of chunk) this.handleByte(ch);
  }

  handleByte(ch) {
    if (this.esc) {
      if (this.esc === 1) {
        if (ch === 0x5b) { this.esc = 2; return; }
        if (ch === 0x1b) return;
        this.esc = 0;
        if (this.menuState) this.handleMenuByte(0x1b);
        return;
      }
      if (this.esc === 2) {
        this.esc = 0;
        if (this.menuState) {
          if (ch === 0x41 || ch === 0x42) this.handleMenuByte(ch);
          return;
        }
        if (ch === 0x41) this.historyBack();
        else if (ch === 0x42) this.historyFwd();
        else if (ch === 0x48) { this.buf = ''; this.redraw(); }
        else if (ch === 0x46) { this.redraw(); }
        return;
      }
      return;
    }
    if (ch === ESC) { this.esc = 1; return; }
    if (this.menuState) {
      this.handleMenuByte(ch);
      return;
    }
    if (ch === 0x0d || ch === 0x0a) { this.submit(); return; }
    if (ch === 0x03) {
      const w = this.waiting;
      this.waiting = null;
      if (w) w(null);
      return;
    }
    if (ch === 0x08 || ch === 0x7f) {
      this.buf = this.buf.slice(0, -1);
      this.redraw();
      return;
    }
    if (ch === 0x0c) { // ctrl+l: clear screen
      this.write('\x1b[2J\x1b[1;1H');
      return;
    }
    if (ch >= 0x20 && ch <= 0x7e) {
      this.buf += String.fromCharCode(ch);
      this.redraw();
    }
  }

  submit() {
    const line = this.buf;
    this.buf = '';
    if (line) {
      this.history.push(line);
      if (this.history.length > 100) this.history.shift();
    }
    this.hIndex = this.history.length;
    process.stdout.write('\r\n');
    const w = this.waiting;
    this.waiting = null;
    if (w) w(line);
  }

  historyBack() {
    if (!this.history.length) return;
    this.hIndex = Math.max(0, this.hIndex - 1);
    this.buf = this.history[this.hIndex] ?? '';
    this.redraw();
  }

  historyFwd() {
    this.hIndex = Math.min(this.history.length, this.hIndex + 1);
    this.buf = this.hIndex >= this.history.length ? '' : (this.history[this.hIndex] ?? '');
    this.redraw();
  }

  redraw() {
    process.stdout.write(`\r\x1b[K${this.promptText}${this.buf}`);
  }

  // Print output safely while a prompt is pending, then restore the line.
  write(text) {
    if (this.waiting || this.menuState) {
      process.stdout.write(`\r\x1b[K${text}\n`);
      if (this.menuState) this.renderMenu();
      else this.redraw();
    } else {
      process.stdout.write(text + '\n');
    }
  }

  prompt(text) {
    return new Promise((resolve) => {
      if (this.closed) return resolve(null);
      this.promptText = text;
      this.waiting = resolve;
      this.redraw();
    });
  }

  clear() {
    this.write('\x1b[2J\x1b[1;1H');
  }

  // ---- arrow-key menu ----
  menu(title, items, hint) {
    return new Promise((resolve) => {
      this.menuState = { title, items, hint, idx: 0, resolve };
      this.renderMenu();
    });
  }

  handleMenuByte(ch) {
    const m = this.menuState;
    if (ch === 0x41 || ch === 0x6b) m.idx = (m.idx + m.items.length - 1) % m.items.length;
    else if (ch === 0x42 || ch === 0x6a) m.idx = (m.idx + 1) % m.items.length;
    else if (ch === 0x0d || ch === 0x0a) {
      this.menuState = null;
      process.stdout.write('\r\n');
      m.resolve(m.items[m.idx]);
      return;
    } else if (ch === 0x1b || ch === 0x71 || ch === 0x03) {
      this.menuState = null;
      process.stdout.write('\r\n');
      m.resolve(null);
      return;
    }
    this.renderMenu();
  }

  renderMenu() {
    const m = this.menuState;
    if (!m) return;
    const lines = [m.title];
    m.items.forEach((item, i) => lines.push(`${i === m.idx ? '> ' : '  '}${item}`));
    if (m.hint) lines.push(m.hint);
    process.stdout.write(`\x1b[J${lines.join('\n')}\n`);
    m.rows = lines.length;
    process.stdout.write(`\x1b[${m.rows}A`);
  }
}
