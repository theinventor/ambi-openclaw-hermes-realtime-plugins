import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { validateSettings, credential, redact } from '../lib/config.mjs';
import { AmbiClient } from '../lib/client.mjs';
import { Journal, atomicJson } from '../lib/journal.mjs';
import { EventPump } from '../lib/pump.mjs';
import { validateEvent, sessionKey, eventPrompt, quote } from '../lib/events.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambi-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'credentials.json');
  atomicJson(configFile, { authToken: 'test-saved-identity', apiUrl: 'http://127.0.0.1:1' });
  return validateSettings({ configFile, stateFile: path.join(dir, 'state/inbox.json'),
    expectedUser: 'user-test', expectedWorkspace: 'workspace-test', cliPath: fixture,
    requestMs: 3000, reconcileMs: 30, retryMs: 10, ...overrides });
}
const event = (id = 'notification-one', extra = {}) => ({ notification_id: id, event_id: 'mention:shared-channel', type: 'mention', resource: { type: 'channel', id: 'channel-one' }, content: { thread_id: 'thread-one' }, actor: { id: 'actor-one' }, ts: '2026-09-14T12:00:00Z', ...extra });
async function until(fn, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() >= end) throw new Error('Timed out waiting for test condition'); await delay(10); }
}
const blocked = signal => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));

test('configuration pins identity and validates paths, bounds and HTTPS', t => {
  const settings = setup(t);
  assert.equal(settings.concurrency, 1);
  for (const change of [{ stateFile: 'relative' }, { concurrency: 33 }, { expectedUser: '' }, { maxPending: 0 }, { sessionMode: 'bad' }, { allowedActors: [1] }, { notBefore: 'invalid' }]) assert.throws(() => validateSettings({ ...settings, ...change }));
  for (const apiUrl of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/?token=secret']) {
    atomicJson(settings.configFile, { authToken: 'test', apiUrl });
    assert.throws(() => credential(settings.configFile));
  }
  assert.equal(redact('Bearer secret-token'), 'Bearer [REDACTED]');
});

test('CLI saved credentials override inherited auth without changing HOME', async t => {
  const settings = setup(t);
  const original = process.env.AMBI_API_TOKEN;
  process.env.AMBI_API_TOKEN = 'wrong-workspace';
  t.after(() => { if (original === undefined) delete process.env.AMBI_API_TOKEN; else process.env.AMBI_API_TOKEN = original; });
  const client = new AmbiClient(settings);
  const result = await client.run(['auth']);
  assert.equal(result.token, 'test-saved-identity');
  assert.equal(result.url, 'http://127.0.0.1:1');
  assert.equal(result.home, process.env.HOME);
  await assert.rejects(client.run(['fail']), error => !error.message.includes('test-saved-identity') && /exited 2/.test(error.message));
  assert.deepEqual(await client.verify(), { id: 'user-test', workspace_id: 'workspace-test' });
  await assert.rejects(new AmbiClient({ ...settings, expectedUser: 'different' }).verify(), /identity changed/);
});

test('CLI handles text output, split UTF-8 and malformed JSON distinctly', async t => {
  const client = new AmbiClient(setup(t));
  assert.match(await client.run(['catalog'], { raw: true }), /tasks create/);
  const rows = [];
  await client.run(['unicode'], { onLine: row => rows.push(row) });
  assert.deepEqual(rows, [{ summary: 'caf\u00e9' }]);
  await assert.rejects(client.run(['invalid']), /invalid JSON/);
  await assert.rejects(client.run(['partial'], { onLine() {} }), /incomplete/);
  const diagnostics = [];
  await assert.rejects(client.run(['fail'], { onDiagnostic: line => diagnostics.push(line) }), /exited 2/);
  assert.deepEqual(diagnostics, ['Bearer [REDACTED]']);
});

test('journal never dispatches an unsaved event or discards a pending row on disk errors', t => {
  const journal = new Journal(setup(t)); journal.open();
  const save = journal.save.bind(journal);
  journal.save = () => { throw new Error('disk full'); };
  assert.throws(() => journal.enqueue(event()), /disk full/);
  assert.equal(journal.rows.size, 0);
  journal.save = save; journal.enqueue(event());
  journal.save = () => { throw new Error('disk full'); };
  assert.throws(() => journal.accept('notification-one'), /disk full/);
  assert.ok(journal.rows.get('notification-one').event);
  assert.throws(() => journal.fail('notification-one'), /disk full/);
  assert.equal(journal.rows.get('notification-one').attempts, 0);
  journal.close();
});

test('hung CLI is bounded, escalated and reaped', async t => {
  const settings = setup(t); const client = new AmbiClient(settings);
  const pidFile = path.join(path.dirname(settings.configFile), 'pid');
  await assert.rejects(client.run(['hang', pidFile], { timeout: 500 }), /timed out/);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await client.run(['hang'], { timeout: 50, normalTimeout: true });
});

test('durable journal deduplicates notification IDs, not shared event IDs', t => {
  const settings = setup(t); const journal = new Journal(settings); journal.open();
  t.after(() => journal.close());
  assert.equal(journal.enqueue(event()), true);
  assert.equal(journal.enqueue(event()), false);
  assert.equal(journal.enqueue(event('notification-two')), true);
  assert.equal(journal.rows.size, 2);
  assert.throws(() => new Journal(settings).open(), /already owns/);
  journal.fail('notification-one');
  journal.close();
  const recovered = new Journal(settings); recovered.open(); t.after(() => recovered.close());
  assert.equal(recovered.rows.get('notification-one').attempts, 1);
  recovered.accept('notification-one');
  assert.equal(recovered.enqueue(event()), false);
  assert.equal(recovered.enqueue(event(), Date.now() + settings.receiptLeaseMs + 1), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(settings.stateFile).mode & 0o777, 0o600);
  recovered.close();
});

test('journal bounds pending work and rejects another workspace without changing state', t => {
  const settings = setup(t, { maxPending: 1 }); const j = new Journal(settings); j.open();
  j.enqueue(event()); assert.throws(() => j.enqueue(event('two')), /full/); j.close();
  const before = fs.readFileSync(settings.stateFile, 'utf8');
  assert.throws(() => new Journal({ ...settings, expectedWorkspace: 'other' }).open(), /identity/);
  assert.equal(fs.readFileSync(settings.stateFile, 'utf8'), before);
  assert.equal(fs.existsSync(`${settings.stateFile}.lock`), false);
});

test('event routing isolates threads and rejects malformed or excluded events', t => {
  const settings = setup(t);
  assert.equal(sessionKey(event(), settings), sessionKey(event('two'), settings));
  assert.notEqual(sessionKey(event(), settings), sessionKey(event('two', { content: { thread_id: 'other' } }), settings));
  assert.notEqual(sessionKey(event(), { ...settings, sessionMode: 'event' }), sessionKey(event('two'), { ...settings, sessionMode: 'event' }));
  assert.equal(sessionKey(event(), { ...settings, sessionMode: 'shared' }), settings.sessionKey);
  assert.throws(() => validateEvent(event('bad;id'), settings), /Malformed/);
  assert.throws(() => validateEvent(event('id', { workspace_id: 'other' }), settings), /another workspace/);
  assert.equal(validateEvent(event(), { ...settings, notBefore: '2026-09-15T00:00:00Z' }), false);
  assert.equal(validateEvent(event(), { ...settings, allowedActors: ['someone-else'] }), false);
  assert.equal(validateEvent(event(), { ...settings, eventTypes: ['email.received'] }), false);
  const prompt = eventPrompt(event(), { ...settings, cliCommand: 'pinned-cli' });
  assert.match(prompt, /was_unread is true/); assert.match(prompt, /NOT posted automatically/);
  assert.equal(quote("a'b"), "'a'\\''b'");
});

test('independent unread reconciliation survives a hung watcher; failures retry durably', async t => {
  const settings = setup(t); const delivered = [], logs = []; let polls = 0, attempts = 0;
  const client = { verify: async () => {}, watch: (_, signal) => blocked(signal), poll: async cursor => {
    polls++; return cursor ? { events: [event('two')], has_more: false } : { events: [event('bad;id'), event()], has_more: true, next_cursor: 'page-two' };
  } };
  const pump = new EventPump(settings, async e => {
    if (++attempts === 1) throw new Error('Gateway temporarily unavailable');
    delivered.push(e.notification_id);
  }, { client, log: (...row) => logs.push(row) });
  t.after(() => pump.stop()); await pump.start();
  await until(() => delivered.length === 2); await delay(100);
  assert.equal(delivered.length, 2); assert.ok(polls >= 4);
  assert.ok(logs.some(([kind, data]) => kind === 'error' && data.stage === 'handoff'));
  assert.ok(logs.some(([kind, data]) => kind === 'error' && data.stage === 'event'));
  await pump.stop(); assert.equal(fs.existsSync(`${settings.stateFile}.lock`), false);
});

test('cursor loops are errors rather than silent truncation', async t => {
  const settings = setup(t);
  const pump = new EventPump(settings, async () => {}, { client: { poll: async () => ({ events: [], has_more: true, next_cursor: 'same' }) } });
  pump.controller = new AbortController(); pump.running = true;
  await assert.rejects(pump.reconcile(), /did not advance/);
});

test('stop during identity verification aborts startup and releases the lock', async t => {
  const settings = setup(t);
  const pump = new EventPump(settings, async () => {}, { client: { verify: signal => blocked(signal) } });
  const starting = pump.start(); await pump.stop(); await starting;
  assert.equal(pump.running, false); assert.equal(fs.existsSync(`${settings.stateFile}.lock`), false);
});

test('handoff timeout preserves pending work and stop does not wait forever', async t => {
  const settings = setup(t, { handoffMs: 60 }); let started = false;
  const client = { verify: async () => {}, watch: (_, signal) => blocked(signal), poll: async () => ({ events: [event()], has_more: false }) };
  const pump = new EventPump(settings, () => { started = true; return new Promise(() => {}); }, { client });
  t.after(() => pump.stop()); await pump.start();
  await until(() => started && pump.journal.rows.get('notification-one')?.attempts > 0);
  await pump.stop(); assert.ok(pump.journal.rows.get('notification-one').event);
});

test('bridge exits on EOF and on startup failure, without a live stdin leak', async t => {
  const settings = setup(t); const settingsFile = path.join(path.dirname(settings.configFile), 'settings.json');
  for (const wrongUser of [false, true]) {
    atomicJson(settingsFile, { ...settings, expectedUser: wrongUser ? 'wrong' : settings.expectedUser });
    const child = spawn(process.execPath, ['bin/ambi-plugins.mjs', 'bridge', '--settings', settingsFile], { stdio: ['pipe', 'ignore', 'pipe'] });
    t.after(() => child.kill());
    let errors = ''; child.stderr.on('data', data => { errors += data; });
    const closed = new Promise(resolve => child.once('close', resolve));
    if (!wrongUser) child.stdin.end();
    const code = await Promise.race([closed, delay(4000).then(() => { throw new Error(`Bridge did not exit: ${errors}`); })]);
    assert.equal(code, wrongUser ? 1 : 0);
  }
});

test('a late bridge acknowledgement cannot accept a subsequent handoff attempt', async t => {
  const settings = setup(t, { handoffMs: 300, retryMs: 10 });
  const settingsFile = path.join(path.dirname(settings.configFile), 'settings.json');
  atomicJson(settingsFile, settings);
  const child = spawn(process.execPath, ['bin/ambi-plugins.mjs', 'bridge', '--settings', settingsFile], {
    env: { ...process.env, AMBI_FIXTURE_EVENTS: JSON.stringify([event()]) }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  child.stderr.resume();
  const closed = new Promise(resolve => child.once('close', resolve));
  const frames = [];
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => frames.push(JSON.parse(line)));
  await until(() => frames.length >= 2);
  assert.notEqual(frames[0].handoff, frames[1].handoff);
  child.stdin.write(JSON.stringify({ handoff: frames[0].handoff, ok: true }) + '\n');
  await delay(30);
  const rows = new Map(JSON.parse(fs.readFileSync(settings.stateFile, 'utf8')).rows);
  assert.ok(rows.get('notification-one').event);
  child.stdin.write(JSON.stringify({ handoff: frames[1].handoff, ok: true }) + '\n');
  await until(() => new Map(JSON.parse(fs.readFileSync(settings.stateFile, 'utf8')).rows).get('notification-one').acceptedAt);
  child.stdin.end(); await closed; lines.close();
});
