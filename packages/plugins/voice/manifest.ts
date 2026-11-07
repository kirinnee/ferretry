import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'voice',
  title: 'Voice',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view', 'command'],
});
