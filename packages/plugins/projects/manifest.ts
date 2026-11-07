import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'projects',
  title: 'Projects',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command', 'view'],
});
