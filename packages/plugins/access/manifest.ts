import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'access',
  title: 'Access',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['session-mode', 'credential-provider', 'view', 'command'],
});
