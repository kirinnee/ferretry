import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'runtimes',
  title: 'Runtimes',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['runtime', 'command', 'view'],
});
