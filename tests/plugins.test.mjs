import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { register } from '../plugins/openclaw/register.mjs';
import { patchHermes, patchOpenClaw, install } from '../lib/install.mjs';
import { validateSettings } from '../lib/config.mjs';

const settings = validateSettings({ configFile: '/saved/credentials.json', stateFile: '/state/inbox.json', settingsFile: '/saved/settings.json', expectedUser: 'user-test', expectedWorkspace: 'workspace-test' });
test('OpenClaw registers a supervised service only in full mode', async () => {
  for (const registrationMode of ['setup', 'cli-metadata']) register({ registrationMode, registerService() { assert.fail('Should not register'); } }, { readSettings() { assert.fail('Should not read credentials'); } });
  let service, deliver, started = 0, stopped = 0, called;
  class Pump { constructor(_, fn) { deliver = fn; } async start() { started++; } async stop() { stopped++; } }
  register({ registerService(value) { service = value; }, runtime: { subagent: { run: async args => { called = args; return { runId: 'run-one' }; } } } }, { Pump, readSettings: () => settings });
  assert.equal(service.id, 'ambi-realtime-watcher');
  await service.start({}); await service.start({});
  await deliver({ notification_id: 'one', type: 'mention' });
  assert.equal(called.deliver, false); assert.match(called.sessionKey, /^agent:main:subagent:ambi-realtime:/);
  assert.match(called.message, /notifications mark-read one/);
  await service.stop(); await service.stop(); assert.equal(started, 1); assert.equal(stopped, 1);
});

test('OpenClaw rejects missing run acknowledgement and cleans failed startup', async () => {
  let service, deliver, stopped = false;
  class Pump { constructor(_, fn) { deliver = fn; } async start() { throw new Error('bad identity'); } async stop() { stopped = true; } }
  register({ registerService(value) { service = value; }, runtime: { subagent: { run: async () => ({}) } } }, { Pump, readSettings: () => settings });
  await assert.rejects(service.start({}), /bad identity/); assert.equal(stopped, true);
  await assert.rejects(deliver({ notification_id: 'one', type: 'mention' }), /did not acknowledge/);
});

test('host configuration patches preserve auth, models, existing plugins and comments', () => {
  const original = { models: { primary: 'keep-model' }, auth: { profile: 'keep-oauth' }, plugins: { allow: ['existing'], entries: { existing: { enabled: true } }, load: { paths: ['/existing'] } } };
  const patched = patchOpenClaw(original, '/plugins/ambi');
  assert.deepEqual(patched.models, original.models); assert.deepEqual(patched.auth, original.auth);
  assert.deepEqual(original.plugins.allow, ['existing']);
  assert.deepEqual(patched.plugins.allow, ['existing', 'ambi-realtime']);
  assert.deepEqual(patchOpenClaw(patched, '/plugins/ambi'), patched);
  const text = '# private settings stay put\nmodel: existing-model\nplugins:\n  enabled: [existing]\nplatform_toolsets:\n  telegram: [hermes-cli]\n';
  const result = patchHermes(text); const config = YAML.parse(result);
  assert.match(result, /private settings stay put/); assert.equal(config.model, 'existing-model');
  assert.deepEqual(config.plugins.enabled, ['existing', 'ambi-realtime']);
  assert.deepEqual(config.platform_toolsets.telegram, ['hermes-cli']);
  assert.equal(patchHermes(result), result);
  assert.throws(() => patchHermes('plugins: {enabled: all}'), /array/);
});

test('installer is repeatable, keeps backups outside discovery, and excludes credentials from the bundle', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ambi-install-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'config.yaml'), '# preserve\nmodel: existing-model\n');
  const identity = { id: 'user-test', workspace_id: 'workspace-test' };
  const options = { home, config: path.join(home, '.ambi/config.json') };
  const deps = { runImpl: () => '' };
  const first = install('hermes', options, identity, deps);
  assert.ok(fs.existsSync(path.join(first.target, 'plugin.yaml')));
  assert.equal(fs.existsSync(path.join(first.target, '.ambi')), false);
  assert.deepEqual(fs.readdirSync(path.join(home, 'plugins')), ['ambi-realtime']);
  const installed = JSON.parse(fs.readFileSync(first.settingsFile, 'utf8'));
  assert.equal(installed.configFile, options.config);
  const second = install('hermes', options, identity, deps);
  assert.ok(fs.existsSync(path.join(second.backup, 'plugin/plugin.yaml')));
  assert.ok(fs.existsSync(path.join(second.backup, 'skill/SKILL.md')));
  assert.deepEqual(fs.readdirSync(path.join(home, 'plugins')), ['ambi-realtime']);
  assert.match(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'), /existing-model/);
  const before = fs.readFileSync(path.join(home, 'config.yaml'), 'utf8');
  assert.throws(() => install('hermes', options, identity, { runImpl() { throw new Error('npm failed'); } }), /npm failed/);
  assert.equal(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'), before);
  assert.ok(fs.existsSync(path.join(first.target, 'plugin.yaml')));
});
