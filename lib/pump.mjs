import { setTimeout as delay } from 'node:timers/promises';
import { AmbiClient } from './client.mjs';
import { Journal } from './journal.mjs';
import { validateEvent } from './events.mjs';
import { redact } from './config.mjs';

const pause = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {});

export class EventPump {
  constructor(settings, deliver, { client = new AmbiClient(settings), journal = new Journal(settings), log = () => {} } = {}) {
    this.settings = settings; this.deliver = deliver; this.client = client; this.journal = journal; this.log = log;
    this.active = new Set(); this.jobs = new Set(); this.running = false;
  }

  start() {
    if (this.starting) return this.starting;
    this.starting = this.initialize();
    return this.starting;
  }

  async initialize() {
    this.journal.open(); this.controller = new AbortController();
    try { await this.client.verify(this.controller.signal); } catch (error) { this.journal.close(); throw error; }
    if (this.controller.signal.aborted) { this.journal.close(); return; }
    this.running = true;
    this.tasks = [this.watchLoop(), this.pollLoop(), this.dispatchLoop()];
    this.log('ready', { user: this.settings.expectedUser, workspace: this.settings.expectedWorkspace });
  }

  enqueue(event) {
    if (!this.running || !validateEvent(event, this.settings)) return;
    if (this.journal.enqueue(event)) this.log('queued', { id: event.notification_id, type: event.type });
  }

  async reconcile() {
    let cursor;
    const cursors = new Set();
    for (let pageIndex = 0; pageIndex < this.settings.maxPages; pageIndex++) {
      const page = await this.client.poll(cursor, this.controller.signal);
      if (!Array.isArray(page?.events)) throw new Error('Unread poll returned no events array');
      for (const event of page.events) this.enqueue(event);
      if (!page.has_more) return;
      if (!page.next_cursor || cursors.has(page.next_cursor)) throw new Error('Unread cursor did not advance');
      cursor = page.next_cursor; cursors.add(cursor);
    }
    throw new Error('Unread pagination limit reached; increase maxPages to drain the backlog');
  }

  async pollLoop() {
    while (this.running) {
      try { await this.reconcile(); } catch (error) { this.error('reconcile', error); }
      await pause(this.settings.reconcileMs, this.controller.signal);
    }
  }

  async watchLoop() {
    let backoff = this.settings.retryMs;
    while (this.running) {
      try {
        await this.client.verify(this.controller.signal);
        await this.client.watch(event => this.enqueue(event), this.controller.signal);
        backoff = this.settings.retryMs;
      } catch (error) { this.error('watch', error); backoff = Math.min(backoff * 2, 30_000); }
      await pause(backoff, this.controller.signal);
    }
  }

  async dispatchLoop() {
    while (this.running) {
      for (const [id, row] of this.journal.rows) {
        if (!this.running || this.active.size >= this.settings.concurrency) break;
        if (!row.event || this.active.has(id) || row.availableAt > Date.now()) continue;
        this.active.add(id);
        const job = this.handoff(id, row.event).finally(() => { this.active.delete(id); this.jobs.delete(job); });
        this.jobs.add(job);
      }
      await pause(50, this.controller.signal);
    }
  }

  async handoff(id, event) {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.settings.handoffMs)]);
    let abort;
    try {
      await Promise.race([
        Promise.resolve().then(() => this.deliver(event, signal)),
        new Promise((_, reject) => {
          abort = () => reject(new Error('Agent handoff interrupted or timed out'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
      if (!this.running) return;
      this.journal.accept(id); this.log('accepted', { id });
    } catch (error) {
      if (this.running) { this.journal.fail(id); this.error('handoff', error, id); }
    } finally { if (abort) signal.removeEventListener('abort', abort); }
  }

  error(stage, error, id) { if (this.running) this.log('error', { stage, id, error: redact(error.message) }); }

  async stop() {
    this.running = false; this.controller?.abort();
    await this.starting?.catch(() => {});
    await Promise.allSettled([...(this.tasks ?? []), ...this.jobs]);
    this.journal.close();
    this.starting = null;
  }
}
