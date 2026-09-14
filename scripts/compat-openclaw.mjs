import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { install } from '../lib/install.mjs';

const sdk = process.env.OPENCLAW_PACKAGE;
if (!sdk) throw new Error('Set OPENCLAW_PACKAGE to the installed OpenClaw package directory');
const version = JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'), 'utf8')).version;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ambi-openclaw-compat-'));
try {
  const result = install('openclaw', { home, config: path.join(home, 'fixture-auth.json'), openclawPackage: sdk }, { id: 'fixture-user', workspace_id: 'fixture-workspace' });
  const entry = (await import(pathToFileURL(path.join(result.target, 'plugins/openclaw/index.js')))).default;
  assert.equal(entry.id, 'ambi-realtime');
  let service;
  entry.register({ registrationMode: 'full', pluginConfig: { settingsFile: result.settingsFile }, registerService(value) { service = value; }, logger: console });
  assert.equal(service.id, 'ambi-realtime-watcher');
  assert.equal(typeof service.start, 'function'); assert.equal(typeof service.stop, 'function');
  const manifest = JSON.parse(fs.readFileSync(path.join(result.target, 'openclaw.plugin.json'), 'utf8'));
  assert.equal(manifest.id, entry.id);
  assert.ok(fs.existsSync(path.join(result.target, 'skills/ambi-realtime/SKILL.md')));
  console.log(`OpenClaw ${version}: real SDK entry import, installed metadata and supervised service registration PASS`);
} finally { fs.rmSync(home, { recursive: true, force: true }); }
