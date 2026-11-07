import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'board',
  title: 'Board',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view', 'command'],
});
