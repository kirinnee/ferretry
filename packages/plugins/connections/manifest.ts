import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'connections',
  title: 'Connections',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['carrier', 'view', 'command'],
});
