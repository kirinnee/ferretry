import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'lessons',
  title: 'Lessons',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['instruction', 'command', 'view'],
});
