import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'logins',
  title: 'Logins',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['login', 'command', 'view'],
});
