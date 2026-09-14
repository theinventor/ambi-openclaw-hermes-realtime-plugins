#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AmbiClient } from '../lib/client.mjs';
import { loadSettings, defaultCredentialFile, redact } from '../lib/config.mjs';
import { EventPump } from '../lib/pump.mjs';
import { eventPrompt, quote, sessionKey } from '../lib/events.mjs';
import { install } from '../lib/install.mjs';

const ownPath = fileURLToPath(import.meta.url);
const separator = process.argv.indexOf('--');
const nativeArgs = separator < 0 ? [] : process.argv.slice(separator + 1);
const { positionals, values } = parseArgs({
  args: process.argv.slice(2, separator < 0 ? undefined : separator), allowPositionals: true,
  options: Object.fromEntries(['settings', 'home', 'config', 'not-before', 'session-mode', 'openclaw-package'].map(name => [name, { type: 'string' }])),
});

async function main() {
  const [command, host] = positionals;
  if (!command || command === 'help') {
    console.log('ambi-plugins install <openclaw|hermes> --config /path/.ambi/config.json [--home /path] [--not-before ISO_TIME]\nambi-plugins doctor --settings /path/settings.local.json\nambi-plugins bridge --settings /path/settings.local.json\nambi-plugins cli --settings /path/settings.local.json -- <ambiguous command>');
    return;
  }
  if (command === 'install') {
    if (!['openclaw', 'hermes'].includes(host)) throw new Error('Choose openclaw or hermes');
    const config = values.config ? path.resolve(values.config) : defaultCredentialFile();
    const client = new AmbiClient({ configFile: config, requestMs: 30_000 });
    const identity = await client.verify();
    const result = install(host, { config, home: values.home ?? path.join(os.homedir(), `.${host}`), notBefore: values['not-before'], sessionMode: values['session-mode'], openclawPackage: values['openclaw-package'] }, identity);
    console.log(JSON.stringify(result, null, 2)); return;
  }
  if (!values.settings) throw new Error('--settings is required');
  const settings = loadSettings(values.settings);
  const client = new AmbiClient(settings);
  if (command === 'cli') {
    if (!nativeArgs.length) throw new Error('Supply an Ambiguous command after --');
    await client.verify();
    process.stdout.write(await client.run(nativeArgs, { raw: true })); return;
  }
  if (command === 'doctor') {
    const me = await client.verify();
    const page = await client.poll();
    const status = await client.run(['api', 'GET', `/api/agents/${me.id}/transport`]);
    console.log(JSON.stringify({ authenticated: true, user: me.id, workspace: me.workspace_id, liveConnected: status.connected, unreadPageCount: page.events?.length, settingsFile: settings.settingsFile }, null, 2)); return;
  }
  if (command !== 'bridge') throw new Error(`Unknown command: ${command}`);
  const pending = new Map();
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', line => {
    try {
      const ack = JSON.parse(line); const waiter = pending.get(ack.handoff);
      if (waiter) ack.ok === true ? waiter.resolve() : waiter.reject(new Error('Native adapter rejected handoff'));
    } catch { process.stderr.write('Ambiguous bridge: invalid acknowledgement\n'); }
  });
  const cliCommand = [process.execPath, ownPath, 'cli', '--settings', settings.settingsFile, '--'].map(quote).join(' ');
  const pump = new EventPump(settings, (event, signal) => new Promise((resolve, reject) => {
    const handoff = randomUUID();
    const done = fn => () => { signal.removeEventListener('abort', abort); pending.delete(handoff); fn(); };
    const abort = () => { pending.delete(handoff); reject(new Error('Handoff stopped')); };
    if (signal.aborted) { abort(); return; }
    pending.set(handoff, { resolve: done(resolve), reject: error => done(() => reject(error))() });
    signal.addEventListener('abort', abort, { once: true });
    process.stdout.write(JSON.stringify({ kind: 'event', handoff, sessionKey: sessionKey(event, settings), event, prompt: eventPrompt(event, { ...settings, cliCommand }) }) + '\n');
  }), { log: (kind, data) => process.stderr.write(JSON.stringify({ component: 'ambi-realtime', kind, ...data }) + '\n') });
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    await pump.stop(); input.close();
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  input.once('close', stop);
  try { await pump.start(); } catch (error) { if (!stopping) { await stop(); throw error; } }
}

main().catch(error => { process.stderr.write(redact(error.message) + '\n'); process.exitCode = 1; });
