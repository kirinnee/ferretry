import { Carriers, DoctorChecks, PluginsChanged, SessionModes } from './contract/index.ts';
import { definePlugin, route } from './manifest/index.ts';

/**
 * The Kernel's own declaration (§2.2). Exported as `@ferretry/kernel/plugin` rather than `./manifest`, because
 * `@ferretry/kernel/manifest` is the SDK every other manifest imports. Its routes are served by `host/kernel-half.ts`.
 */
export default definePlugin({
  id: 'kernel',
  title: 'Kernel',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  words: [
    { word: 'home', means: 'the folder a daemon keeps everything in', insteadOf: ['state home', 'FY_HOME'] },
    { word: 'data', means: 'what a plugin keeps in its folder', insteadOf: ['store', 'db'] },
    { word: 'job', means: 'background work a plugin runs', insteadOf: ['timer', 'loop'] },
    { word: 'identity', means: "the daemon's own signing key", insteadOf: ['fingerprint'] },
  ],
  actions: {
    routes: [
      // §9.6: the session-layer version, read before anything else (the full-screen skew sentence needs it pre-auth).
      route('GET /v1/health', {
        minimum: 'none',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a version read records nothing' },
        guard: { none: 'the protocol number and the daemon version only' },
      }),
      // Today's liveness answer, kept (parity): `fy daemon status` and supervisors wait on it.
      route('GET /healthz', {
        minimum: 'none',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a liveness read records nothing' },
        guard: { none: 'status, uptime, pid and version only' },
      }),
      // §9.6 review r13 finding 3: Gate's descriptor for the inventory read.
      route('GET /v1/plugins', {
        minimum: 'authenticated',
        caller: 'any',
        unlockExempt: true,
        noStore: true,
        audit: { skip: 'the bootstrap read records nothing' },
        guard: { none: 'plugin ids, on/off and contract hashes only' },
      }),
      // §1.3.
      route('GET /v1/glossary', {
        minimum: 'authenticated',
        caller: 'any',
        audit: { skip: 'public vocabulary' },
        guard: { none: 'public vocabulary' },
      }),
    ],
  },
  data: { publishes: [PluginsChanged] },
  hooks: {
    offers: [{ hook: Carriers }, { hook: SessionModes }, { hook: DoctorChecks }],
  },
});
