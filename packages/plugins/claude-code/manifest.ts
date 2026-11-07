import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'claude-code',
  title: 'Claude Code',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['harness', 'command', 'view'],
});
