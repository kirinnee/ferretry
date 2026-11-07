import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'shells',
  title: 'Shells',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['item', 'command', 'view'],
});
