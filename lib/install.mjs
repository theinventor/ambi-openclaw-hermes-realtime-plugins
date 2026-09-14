import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { atomicJson } from './journal.mjs';
import { validateSettings } from './config.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['package.json', 'package-lock.json', 'openclaw.plugin.json', 'plugin.yaml', '__init__.py', 'LICENSE', 'README.md', 'bin', 'lib', 'plugins', 'skills'];

export function patchOpenClaw(config, target) {
  const result = structuredClone(config);
  result.plugins ??= {};
  result.plugins.entries ??= {};
  result.plugins.entries['ambi-realtime'] = { enabled: true, config: { settingsFile: path.join(target, 'settings.local.json') } };
  result.plugins.load ??= {};
  result.plugins.load.paths = [...new Set([...(result.plugins.load.paths ?? []), target])];
  if (Array.isArray(result.plugins.allow) && !result.plugins.allow.includes('ambi-realtime')) result.plugins.allow.push('ambi-realtime');
  return result;
}

export function patchHermes(text) {
  const doc = YAML.parseDocument(text || '{}');
  if (doc.errors.length) throw new Error('Hermes config contains invalid YAML');
  const enabled = doc.getIn(['plugins', 'enabled'], true)?.toJSON() ?? [];
  if (!Array.isArray(enabled)) throw new Error('Hermes plugins.enabled must be an array');
  doc.setIn(['plugins', 'enabled'], [...new Set([...enabled, 'ambi-realtime'])]);
  doc.setIn(['platform_toolsets', 'ambi-realtime'], ['hermes-cli']);
  for (const [key, value] of Object.entries({ long_running_notifications: false, interim_assistant_messages: false, tool_progress: 'off' })) doc.setIn(['display', 'platforms', 'ambi-realtime', key], value);
  return String(doc);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed while preparing plugin dependencies: ${result.error?.message ?? result.stderr.slice(-1500)}`);
  return result.stdout.trim();
}

export function install(host, options, identity, { runImpl = run } = {}) {
  if (!['openclaw', 'hermes'].includes(host)) throw new Error('Host must be openclaw or hermes');
  const home = path.resolve(options.home);
  if (process.geteuid && fs.existsSync(home) && fs.statSync(home).uid !== process.geteuid()) throw new Error('Run the installer as the runtime home owner (in Docker, use docker exec --user UID:GID)');
  const target = path.join(home, host === 'hermes' ? 'plugins' : 'extensions', 'ambi-realtime');
  if (target === root) throw new Error('Cannot install over the source repository');
  const configPath = path.join(home, host === 'hermes' ? 'config.yaml' : 'openclaw.json');
  const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '{}';
  const patched = host === 'hermes' ? patchHermes(original) : JSON.stringify(patchOpenClaw(JSON.parse(original), target), null, 2) + '\n';
  if (host === 'hermes') {
    for (const candidate of [path.join(home, 'hermes-agent/plugins/ambi-realtime'), path.join(home, 'workspace/plugins/ambi-realtime')]) {
      if (fs.existsSync(candidate)) throw new Error(`A shadowing plugin exists at ${candidate}; resolve it before installation`);
    }
  }
  const settings = validateSettings({
    configFile: path.resolve(options.config), stateFile: path.join(home, 'state/ambi-realtime/inbox.json'),
    expectedUser: identity.id, expectedWorkspace: identity.workspace_id, nodePath: process.execPath,
    notBefore: options.notBefore ?? null, sessionMode: options.sessionMode ?? 'thread',
  });
  const backupDir = path.join(home, 'backups/ambi-realtime', `${Date.now()}-${randomUUID()}`);
  const stage = path.join(home, '.ambi-plugin-staging', randomUUID());
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  const skill = path.join(home, 'skills/ambi-realtime');
  let previous, previousSkill, configBackup, published = false, configChanged = false, skillChanged = false;
  const configExisted = fs.existsSync(configPath);
  try {
    for (const file of files) fs.cpSync(path.join(root, file), path.join(stage, file), { recursive: true, filter: p => !p.includes('__pycache__') && !p.endsWith('.pyc') });
    runImpl(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
    if (host === 'openclaw') {
      const sdk = options.openclawPackage ?? path.join(runImpl('npm', ['root', '-g']), 'openclaw');
      if (!fs.existsSync(path.join(sdk, 'package.json'))) throw new Error('OpenClaw SDK not found; pass --openclaw-package /absolute/path/to/openclaw');
      fs.symlinkSync(sdk, path.join(stage, 'node_modules/openclaw'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    atomicJson(path.join(stage, 'settings.local.json'), settings);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (configExisted) {
      configBackup = path.join(backupDir, path.basename(configPath));
      fs.copyFileSync(configPath, configBackup);
      fs.chmodSync(configBackup, 0o600);
    }
    if (fs.existsSync(target)) {
      previous = path.join(backupDir, 'plugin');
      fs.renameSync(target, previous);
    }
    fs.renameSync(stage, target);
    published = true;
    if (host === 'hermes') {
      if (fs.existsSync(skill)) {
        previousSkill = path.join(backupDir, 'skill');
        fs.renameSync(skill, previousSkill);
      }
      skillChanged = true;
      fs.cpSync(path.join(target, 'skills/ambi-realtime'), skill, { recursive: true });
    }
    const temp = `${configPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, patched, { mode: 0o600 });
      fs.renameSync(temp, configPath); configChanged = true;
    } finally { fs.rmSync(temp, { force: true }); }
    return { host, target, settingsFile: path.join(target, 'settings.local.json'), configPath, backup: backupDir, restartRequired: true };
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    if (configChanged) {
      if (configBackup) fs.copyFileSync(configBackup, configPath);
      else fs.rmSync(configPath, { force: true });
    }
    if (skillChanged) fs.rmSync(skill, { recursive: true, force: true });
    if (previousSkill) fs.renameSync(previousSkill, skill);
    if (published) fs.rmSync(target, { recursive: true, force: true });
    if (previous && !fs.existsSync(target)) fs.renameSync(previous, target);
    throw error;
  }
}
