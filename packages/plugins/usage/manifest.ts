import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'usage',
  title: 'Usage',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command', 'view'],
});
