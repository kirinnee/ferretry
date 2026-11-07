import type { ConfigDef } from '@ferretry/kernel/contract';
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
  UpdatesPort,
  UPDATES_CONFIG,
  UPDATES_LATEST,
  UPDATES_LOG,
  UPDATES_REPORT,
  USE,
} from './contract/index.ts';

/**
 * Updates (§2.3): keeps the daemon current — checks for a release, installs it when no ferret is mid-turn, restarts,
 * and tells the app when a daemon is behind. Routes copied from today's `runtime/mounts/daemon-update.ts`; the agent
 * CLIs' updates (`/v1/<harness>/update`, `fy harness <id> update`) belong to the harness plugins (§1.4).
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
    state: [UPDATES_LATEST, UPDATES_REPORT, UPDATES_LOG],
    config: [UPDATES_CONFIG as ConfigDef],
    readModels: ['status'],
    publishes: [UpdateAvailable, UpdateFinished],
  },

  hooks: { takes: [{ hook: FerretChanged }] },

  doctor: ['update'],

  permissions: {
    network: ['api.github.com', 'github.com', 'objects.githubusercontent.com'],
    spawn: ['nix', 'brew', 'dpkg', 'rpm', 'apt-get', 'dnf', 'yum'],
  },
});
