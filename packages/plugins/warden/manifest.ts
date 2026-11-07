import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'warden',
  title: 'Warden',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command', 'view'],
});
