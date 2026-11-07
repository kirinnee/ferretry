import { type ConfigDef, defineConfig, defineState } from '@ferretry/kernel/contract';
import { definePlugin, panel, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import { FerretChanged, FerretsPort } from '@ferretry/core-ferrets/contract';
import {
  AUDIT,
  CONFIGURE,
  GUARD_NONE,
  SKIP_READ,
  UPDATES_WORDS,
  UpdateAvailable,
  UpdateFinished,
  UpdatesConfigSchema,
  UpdatesPort,
  USE,
  updatesLoosens,
} from './contract/index.ts';

/**
 * Updates (§2.3): keeps the daemon current — checks for a release, installs it when no ferret is mid-turn, restarts,
 * and tells the app when a daemon is behind. Routes copied from today's `runtime/mounts/{daemon-update,
 * harness-update}.ts`; the agent CLIs' `fy harness <id> update` verbs belong to the harness plugins (§1.4).
 */
export default definePlugin({
  id: 'updates',
  title: 'Updates',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command', 'view'],
  words: UPDATES_WORDS,

  needs: { ferrets: FerretsPort },
  provides: { updates: UpdatesPort },

  actions: {
    routes: [
      route('GET /v1/daemon/update', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.fleet,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/daemon/update', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.fleet,
        noStore: true,
        audit: { record: AUDIT.securityChanged },
        guard: GUARD_NONE,
      }),
      route('PATCH /v1/daemon/update/settings', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.fleet,
        noStore: true,
        audit: { record: AUDIT.securityChanged },
        guard: GUARD_NONE,
      }),
      route('GET /v1/harnesses/update', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.fleet,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/harnesses/update', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.fleet,
        noStore: true,
        audit: { record: AUDIT.securityChanged },
        guard: GUARD_NONE,
      }),
    ],
    cli: [
      verb('update', {
        summary:
          'update the daemon the way this machine installed it, restart it, and roll back if it does not come up',
      }),
    ],
  },

  ui: {
    settings: [settingsTab('updates', { label: 'Updates', order: 60 })],
    panels: [panel('daemon.status', { id: 'behind', order: 30 })],
  },

  data: {
    state: [
      defineState({ name: 'latest', path: 'update/latest.json', store: 'json', format: 1 }),
      defineState({ name: 'report', path: 'update/report.json', store: 'json', format: 1 }),
      defineState({ name: 'log', path: 'update.log', store: 'opaque', format: 1 }),
    ],
    config: [
      defineConfig({
        file: 'updates.yaml',
        schema: UpdatesConfigSchema,
        axis: 'configure',
        loosens: updatesLoosens,
      }) as ConfigDef,
    ],
    readModels: ['status'],
    publishes: [UpdateAvailable, UpdateFinished],
  },

  hooks: { takes: [{ hook: FerretChanged }] },

  doctor: ['update'],

  permissions: {
    network: ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'registry.npmjs.org'],
    spawn: ['nix', 'brew', 'dpkg', 'rpm', 'apt-get', 'dnf', 'yum', 'npm', 'pnpm', 'bun', 'volta', 'claude', 'codex'],
  },
});
