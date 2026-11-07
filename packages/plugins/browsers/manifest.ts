import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'browsers',
  title: 'Browsers',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['tool', 'command', 'view'],
});
