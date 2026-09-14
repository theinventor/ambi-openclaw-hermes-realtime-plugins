import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventPump } from '../../lib/pump.mjs';
import { loadSettings } from '../../lib/config.mjs';
import { eventPrompt, quote, sessionKey } from '../../lib/events.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function register(api, { Pump = EventPump, readSettings = loadSettings } = {}) {
  if ((api.registrationMode ?? 'full') !== 'full') return;
  const cfg = api.pluginConfig ?? api.config?.plugins?.entries?.['ambi-realtime']?.config ?? {};
  const settings = readSettings(cfg.settingsFile ?? path.join(root, 'settings.local.json'));
  const logger = api.logger ?? api.log ?? console;
  let pump;
  api.registerService({
    id: 'ambi-realtime-watcher',
    async start(ctx) {
      if (pump) return;
      const candidate = new Pump(settings, async event => {
        if (!api.runtime?.subagent?.run) throw new Error('OpenClaw runtime.subagent.run is unavailable');
        const cliCommand = [process.execPath, path.join(root, 'bin/ambi-plugins.mjs'), 'cli', '--settings', settings.settingsFile, '--'].map(quote).join(' ');
        const run = await api.runtime.subagent.run({
          sessionKey: sessionKey(event, settings), message: eventPrompt(event, { ...settings, cliCommand }), deliver: false,
        });
        if (!run?.runId) throw new Error('OpenClaw did not acknowledge the agent run');
      }, { log(kind, data) {
        if (kind === 'error') {
          logger.warn?.(`Ambiguous ${data.stage}: ${data.error}`);
          ctx?.serviceHealth?.reportFailure?.(new Error(data.error));
        } else {
          logger.info?.(`Ambiguous ${kind}${data.id ? ` notification=${data.id}` : ''}${data.message ? ` ${data.message}` : ''}`);
          if (kind === 'accepted') ctx?.serviceHealth?.clearFailure?.();
        }
      } });
      pump = candidate;
      try { await candidate.start(); } catch (error) { pump = null; await candidate.stop(); throw error; }
    },
    async stop() { const previous = pump; pump = null; await previous?.stop(); },
  });
}
