import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { register } from './register.mjs';

export default definePluginEntry({
  id: 'ambi-realtime', name: 'Ambiguous Realtime',
  description: 'Wakes agent sessions for directed Ambiguous Workspace events.',
  register,
});
