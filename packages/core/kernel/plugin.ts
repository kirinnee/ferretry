import { Carriers, DoctorChecks, SessionModes } from './contract/index.ts';
import { definePlugin } from './manifest/index.ts';

/**
 * The Kernel's own declaration (§2.2). Exported as `@ferretry/kernel/plugin` rather than `./manifest`, because
 * `@ferretry/kernel/manifest` is the SDK every other manifest imports.
 */
export default definePlugin({
  id: 'kernel',
  title: 'Kernel',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  hooks: {
    offers: [{ hook: Carriers }, { hook: SessionModes }, { hook: DoctorChecks }],
  },
});
