import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function loadSettings(file) {
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  return validateSettings({ ...settings, settingsFile: path.resolve(file) });
}

export function validateSettings(input) {
  const settings = {
    reconcileMs: 15_000, watchMs: 90_000, requestMs: 30_000,
    retryMs: 5_000, handoffMs: 120_000, receiptLeaseMs: 900_000,
    concurrency: 1, maxPending: 500, maxReceipts: 10_000, maxPages: 100,
    sessionKey: 'agent:main:subagent:ambi-realtime', sessionMode: 'thread',
    eventTypes: [], allowedActors: [], notBefore: null, ...input,
  };
  for (const key of ['configFile', 'stateFile']) {
    if (!path.isAbsolute(settings[key] ?? '')) throw new Error(`${key} must be an absolute path`);
  }
  for (const key of ['expectedUser', 'expectedWorkspace']) {
    if (typeof settings[key] !== 'string' || !settings[key]) throw new Error(`${key} is required`);
  }
  for (const key of ['reconcileMs', 'watchMs', 'requestMs', 'retryMs', 'handoffMs', 'receiptLeaseMs', 'concurrency', 'maxPending', 'maxReceipts', 'maxPages']) {
    if (!Number.isSafeInteger(settings[key]) || settings[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (settings.concurrency > 32) throw new Error('concurrency must not exceed 32');
  for (const key of ['eventTypes', 'allowedActors']) {
    if (!Array.isArray(settings[key]) || settings[key].some(x => typeof x !== 'string')) throw new Error(`${key} must be a string array`);
  }
  if (!['thread', 'event', 'shared'].includes(settings.sessionMode)) throw new Error('Invalid sessionMode');
  if (typeof settings.sessionKey !== 'string' || !/^agent:[a-zA-Z0-9_-]+:subagent:[a-zA-Z0-9:_-]+$/.test(settings.sessionKey)) throw new Error('Invalid sessionKey');
  if (settings.notBefore && !Number.isFinite(Date.parse(settings.notBefore))) throw new Error('Invalid notBefore timestamp');
  return settings;
}

export function credential(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof data.authToken !== 'string' || !data.authToken.trim()) throw new Error('Saved Ambiguous authToken is missing');
  const url = new URL(data.apiUrl ?? 'https://app.ambiguous.ai');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('apiUrl must be an origin without credentials');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Ambiguous requires HTTPS (except loopback tests)');
  return { token: data.authToken, apiUrl: url.origin };
}

export function defaultCredentialFile() {
  const options = [path.join(process.cwd(), '.ambi/config.json'), path.join(os.homedir(), '.ambi/config.json'), path.join(os.homedir(), '.config/ambiguous/config.json')];
  const file = options.find(p => fs.existsSync(p));
  if (!file) throw new Error('No saved Ambiguous credential. Pass --config /absolute/path/.ambi/config.json');
  return file;
}

export function redact(value) {
  return String(value).replace(/\b(?:ak_|sk-|mmb_)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/(?:cap-v1-|auth-)?eyJ[A-Za-z0-9_.-]+/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}
