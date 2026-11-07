import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'terminals',
  title: 'Terminals',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['tool', 'runner', 'command', 'view'],
});
