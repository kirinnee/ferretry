import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'packs',
  title: 'Packs',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command', 'view'],
});
