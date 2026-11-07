import { definePlugin } from '@ferretry/kernel/manifest';

export default definePlugin({
  id: 'onboarding',
  title: 'Onboarding',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['onboarding', 'view'],
});
