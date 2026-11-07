import { type ConfigDef, defineConfig, defineState } from '@ferretry/kernel/contract';
import { definePlugin, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import { FerretChanged, FerretsPort } from '@ferretry/core-ferrets/contract';
import { BoardPort } from '@ferretry/plugin-board/contract';
import {
  AUDIT_SKIP,
  GUARD_NONE,
  HousekeepingSchema,
  TidyConfigSchema,
  TidyPort,
  tidyLoosens,
  USE,
} from './contract/index.ts';

/**
 * Tidy (§2.3): cleans up what a stopped ferret left behind (its scratch), and plans one ferret's own clean-up of cards
 * nobody asked for. Routes are copied from today's `runtime/mounts/{scratch-gc,tidy}.ts`; the speed-up routes that
 * shared that module belong to Voice, and the housekeeping worker (credential and usage reads, rollout discovery) to
 * Usage, Logins and Codex.
 *
 * `uses: board` is OPTIONAL and not on §2.4's map: the plan reads the calling ferret's cards and whether their board is
 * on. Without Board, the plan route says so (503) and the scratch sweep is unaffected. Needs the lead's yes.
 */
export default definePlugin({
  id: 'tidy',
  title: 'Tidy',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command', 'view'],

  needs: { ferrets: FerretsPort },
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
      verb('gc', { summary: 'reclaim the files stopped ferrets left behind, once past the wait (daemon data is never touched)' }),
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
    state: [
      defineState({
        name: 'housekeeping',
        path: 'housekeeping.json',
        store: 'json',
        format: 1,
        schema: HousekeepingSchema,
      }),
    ],
    config: [
      defineConfig({
        file: 'tidy.yaml',
        schema: TidyConfigSchema,
        axis: 'configure',
        loosens: tidyLoosens,
      }) as ConfigDef,
    ],
    readModels: ['totals'],
  },

  hooks: { takes: [{ hook: FerretChanged }] },

  permissions: { roots: ['worktrees'] },
});
