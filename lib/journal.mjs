import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(data) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

export class Journal {
  constructor(settings) { this.settings = settings; this.rows = new Map(); this.locked = false; }

  open() {
    const file = this.settings.stateFile;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.lock = `${file}.lock`;
    try {
      fs.writeFileSync(this.lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(this.lock, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid listener lock; inspect it before removing');
      try { process.kill(pid, 0); } catch (probe) {
        if (probe.code === 'ESRCH') {
          fs.unlinkSync(this.lock);
          fs.writeFileSync(this.lock, String(process.pid), { flag: 'wx', mode: 0o600 });
          this.locked = true;
        } else throw probe;
      }
      if (!this.locked) throw new Error('An Ambiguous listener already owns this state file');
    }
    this.locked = true;
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.version !== 1 || data.user !== this.settings.expectedUser || data.workspace !== this.settings.expectedWorkspace || !Array.isArray(data.rows)) throw new Error('Journal does not match the configured identity');
        this.rows = new Map(data.rows);
      }
    } catch (error) { this.close(); throw error; }
  }

  save() {
    atomicJson(this.settings.stateFile, { version: 1, user: this.settings.expectedUser, workspace: this.settings.expectedWorkspace, rows: [...this.rows] });
  }

  enqueue(event, now = Date.now()) {
    const id = event.notification_id;
    const existing = this.rows.get(id);
    if (existing && (existing.event || now - existing.acceptedAt < this.settings.receiptLeaseMs)) return false;
    const pending = [...this.rows.values()].filter(row => row.event).length;
    if (pending >= this.settings.maxPending) throw new Error('Pending notification queue is full; unread events will be retried');
    this.rows.set(id, { event, availableAt: now, attempts: 0 });
    this.save();
    return true;
  }

  accept(id) {
    this.rows.delete(id);
    this.rows.set(id, { acceptedAt: Date.now() });
    for (const [key, value] of this.rows) {
      if (this.rows.size <= this.settings.maxReceipts) break;
      if (!value.event) this.rows.delete(key);
    }
    this.save();
  }

  fail(id) {
    const row = this.rows.get(id);
    if (!row?.event) return;
    row.attempts++;
    row.availableAt = Date.now() + Math.min(this.settings.retryMs * 2 ** Math.min(row.attempts - 1, 6), 300_000);
    this.save();
  }

  close() {
    if (this.locked) { fs.unlinkSync(this.lock); this.locked = false; }
  }
}
