import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.join(__dirname, 'bridge.ps1');

export class Bridge {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.version = '';
    this.apiRevision = '';
    this.child = null;
    this.buf = '';
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      this.child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-File', BRIDGE_SCRIPT,
      ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

      this.child.once('error', (err) => {
        clearTimeout(this.timer);
        reject(new Error(`could not start powershell.exe: ${err.message}`));
      });
      this.child.once('exit', (code) => this.onExit(code));
      this.child.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (d) => this.onData(d));

      this.onReady = (info) => {
        clearTimeout(this.timer);
        this.version = info.version || '';
        this.apiRevision = info.apiRevision || '';
        resolve(this);
      };

      this.timer = setTimeout(() => {
        try { this.child.kill(); } catch { }
        reject(new Error('PowerShell bridge did not start in time'));
      }, timeoutMs);
    });
  }

  onData(chunk) {
    this.buf += chunk.replace(/^\uFEFF/, '');
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === 0 && this.onReady) {
        this.onReady(msg.result || {});
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'unknown bridge error'));
    }
  }

  onExit(code) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`bridge exited unexpectedly (code ${code})`));
    }
    this.pending.clear();
  }

  call(op, args = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.killed) {
        return reject(new Error('bridge is not running'));
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for '${op}'`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, op, args }) + '\n');
    });
  }

  async close() {
    try { await this.call('exit', {}, 3000); } catch { }
    try { this.child.kill(); } catch { }
    this.child = null;
  }
}
