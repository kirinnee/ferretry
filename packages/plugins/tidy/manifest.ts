import { definePlugin, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import { AsksPort } from '@ferretry/core-asks/contract';
import { FerretChanged, FerretsPort } from '@ferretry/core-ferrets/contract';
import { BoardPort } from '@ferretry/plugin-board/contract';
import { AUDIT_SKIP, GUARD_NONE, HousekeepingFile, TidyConfigDef, TidyPort, USE } from './contract/index.ts';

/**
 * Tidy (§2.3): cleans up what a stopped ferret left behind (its scratch), and plans one ferret's own clean-up of cards
 * nobody asked for. Routes are copied from today's `runtime/mounts/{scratch-gc,tidy}.ts`; the speed-up routes that
 * shared that module belong to Voice, and the housekeeping worker (credential and usage reads, rollout discovery) to
 * Usage, Logins and Codex.
 *
 * Beyond §2.4's map (needs the lead's yes): `needs: asks` (core) so the plan can read the calling ferret's own asks, and
 * `uses: board` (optional) for its cards and whether their board is on. Without Board, the plan route says so (503)
 * and the scratch sweep is unaffected.
 */
export default definePlugin({
  id: 'tidy',
  title: 'Tidy',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command', 'view'],

  needs: { ferrets: FerretsPort, asks: AsksPort },
  uses: { board: BoardPort },
  provides: { tidy: TidyPort },

  actions: {
    routes: [
      route('GET /v1/gc', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: AUDIT_SKIP.read,
        guard: GUARD_NONE,
      }),
      route('POST /v1/gc', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: AUDIT_SKIP.sweep,
        guard: GUARD_NONE,
      }),
      route('POST /v1/tidy/plan', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.fleet,
        noStore: true,
        audit: AUDIT_SKIP.plan,
        guard: GUARD_NONE,
      }),
    ],
    cli: [
      verb('gc', {
        summary: 'reclaim the files stopped ferrets left behind, once past the wait (daemon data is never touched)',
      }),
      verb('tidy', {
        summary:
          'drop your own cards nobody asked for and close your own asks that only track work (dry run unless --yes)',
      }),
    ],
  },

  ui: {
    settings: [settingsTab('tidy', { label: 'Tidy', order: 70 })],
  },

  data: {
    state: [HousekeepingFile],
    config: [TidyConfigDef],
    readModels: ['totals'],
  },

  hooks: { takes: [{ hook: FerretChanged }] },

  permissions: { roots: ['worktrees'] },
});
