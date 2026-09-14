import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { credential, redact } from './config.mjs';

const require = createRequire(import.meta.url);
export const cliPath = () => path.join(path.dirname(require.resolve('ambiguous/package.json')), 'dist/index.js');

export class AmbiClient {
  constructor(settings, { spawnImpl = spawn } = {}) {
    this.settings = settings;
    this.spawn = spawnImpl;
  }

  run(args, { signal, timeout = this.settings.requestMs, onLine, onDiagnostic, normalTimeout = false, raw = false } = {}) {
    const { token, apiUrl } = credential(this.settings.configFile);
    const env = { ...process.env, AMBI_API_TOKEN: token, AMBI_API_URL: apiUrl, NO_COLOR: '1' };
    // Explicit file selection wins over a supervisor's inherited workspace identity.
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Stopped'));
      const child = this.spawn(process.execPath, [this.settings.cliPath ?? cliPath(), ...args], {
        env, cwd: path.dirname(this.settings.configFile), stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      let stdout = '', stderr = '', pending = '', diagnostic = '', failure, expired = false, killTimer;
      const report = line => onDiagnostic?.(redact(line.replaceAll(token, '[REDACTED]')).slice(0, 2000));
      const stop = () => {
        if (child.exitCode !== null) return;
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2_000);
        killTimer.unref?.();
      };
      const timer = setTimeout(() => { expired = true; stop(); }, timeout);
      const clean = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', stop); };
      signal?.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', chunk => {
        if (!onLine) {
          stdout += chunk;
          if (stdout.length > 8 * 1024 * 1024) { failure = new Error('CLI output exceeds 8 MiB'); stop(); }
          return;
        }
        pending += chunk;
        if (pending.length > 1024 * 1024) { failure = new Error('Watch frame exceeds 1 MiB'); stop(); return; }
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try { onLine(JSON.parse(line)); } catch (error) { failure = error; stop(); break; }
        }
      });
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk).slice(-8192);
        if (!onDiagnostic) return;
        diagnostic += chunk;
        if (diagnostic.length > 65_536) { diagnostic = ''; report('Oversize CLI diagnostic omitted'); return; }
        const lines = diagnostic.split('\n'); diagnostic = lines.pop();
        for (const line of lines) if (line.trim()) report(line);
      });
      child.once('error', error => { clean(); reject(error); });
      child.once('close', code => {
        clean();
        if (diagnostic.trim()) report(diagnostic);
        if (signal?.aborted) return reject(new Error('Stopped'));
        if (failure) return reject(failure);
        if (expired && normalTimeout) return resolve(null);
        if (expired) return reject(new Error('Ambiguous CLI timed out'));
        if (code !== 0) return reject(new Error(`Ambiguous CLI exited ${code}: ${redact(stderr.replaceAll(token, '[REDACTED]')).slice(-1200)}`));
        if (onLine) {
          if (pending.trim()) return reject(new Error('Watch ended with an incomplete JSON line'));
          return resolve(null);
        }
        if (raw) return resolve(stdout);
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Ambiguous CLI returned invalid JSON')); }
      });
    });
  }

  async verify(signal) {
    const me = await this.run(['api', 'GET', '/api/users/me'], { signal });
    if (!me?.id || !me?.workspace_id) throw new Error('Ambiguous returned an invalid identity');
    if ((this.settings.expectedUser && me.id !== this.settings.expectedUser) ||
        (this.settings.expectedWorkspace && me.workspace_id !== this.settings.expectedWorkspace)) throw new Error('Ambiguous identity changed; refusing to dispatch');
    return me;
  }

  poll(cursor, signal) {
    const args = ['notifications', 'poll', '--limit', '100', '--expected-user', this.settings.expectedUser, '--expected-workspace', this.settings.expectedWorkspace];
    if (cursor) args.push('--cursor', cursor);
    return this.run(args, { signal });
  }

  watch(onLine, signal, onDiagnostic) {
    return this.run(['notifications', 'watch'], {
      signal, onLine, onDiagnostic, timeout: this.settings.watchMs, normalTimeout: true,
    });
  }
}
