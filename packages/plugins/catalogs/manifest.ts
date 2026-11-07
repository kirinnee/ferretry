import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'catalogs',
  title: 'Catalogs',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['session-mode', 'credential-provider', 'item', 'command', 'view'],
});
