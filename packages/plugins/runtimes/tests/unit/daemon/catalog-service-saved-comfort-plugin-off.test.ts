/**
 * A SAVED pinned Claude profile holds a layer on Claude's comfort settings (`realisedEdits` writes the built-in layers into it), and
 * the fleet is published from the files with Claude's plugin OFF (E-276 PR 17b-2, review r1). The comfort component is Claude's
 * plugin's, but its NAME is a fact that holds with the plugin off, so that saved layer is known, never an unreadable component:
 * `publishFromFiles` does not refuse the whole fleet, Codex is published available, and Claude is published unavailable with the
 * typed runtime-wide refusal, exactly as before the harness-kit move.
 */
import { describe, expect, it } from 'bun:test';
import { fakeLoginChanges, fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { ProfileFile, RuntimeFile } from '../../../contract/index.ts';
import {
  assembleRuntimesModel,
  NO_COMPONENTS,
  type RuntimesFiles,
} from '../../../daemon/lib/account/runtimes-model.ts';
import { unavailableCatalogDeps } from '../../../daemon/lib/service/assembly.ts';
import { FleetCatalogService, type FleetCatalogServiceDeps } from '../../../daemon/lib/service/catalog-service.ts';
import type { FleetApplyPlan } from '../../../daemon/lib/provisioning.ts';
import { REAL_KITS, REAL_SIGN_IN } from '../../support/real-kits.ts';
import { TEST_STARTERS } from '../../support/starters.ts';

const NOW = 1_794_052_800_000;

const LAYOUT = {
  stateHome: '/fy',
  userHome: '/home/person',
  fleetDirectory: '/fy/fleet',
  binDirectory: '/fy/fleet/bin',
  homesDirectory: '/fy/fleet/homes',
  assetsDirectory: '/fy/fleet/assets',
  manifestPath: '/fy/fleet/manifest.json',
  defaultHomeDirectories: ['/home/person/.claude', '/home/person/.codex'],
} as const;

/** What a pinned profile saved by a change holds: the built-in layers, among them Claude's comfort settings. */
const SAVED: ReadonlyMap<string, ProfileFile> = new Map([
  [
    'saved-claude',
    {
      contents: ['modelSets/ferretry-claude', 'instructions/ferretry-work-alone', 'settings/ferretry-claude-comfort'],
    } as ProfileFile,
  ],
  ['saved-codex', { contents: ['modelSets/ferretry-codex', 'instructions/ferretry-work-alone'] } as ProfileFile],
]);

const RUNTIMES: ReadonlyMap<string, RuntimeFile> = new Map([
  ['claude-saved', { login: 'claude-you', profile: 'saved-claude' } as RuntimeFile],
  ['codex-saved', { login: 'codex-you', profile: 'saved-codex' } as RuntimeFile],
]);

const LOGINS = [sampleLogin('claude-you'), sampleLogin('codex-you', { harness: 'codex', harnesses: ['codex'] })];

const filesFor = (kits: RuntimesFiles['kits']): RuntimesFiles => ({
  runtimes: RUNTIMES,
  profiles: SAVED,
  modelSets: new Map(),
  settings: undefined,
  logins: LOGINS,
  templates: new Map(),
  components: NO_COMPONENTS,
  starters: TEST_STARTERS,
  kits,
});

const NO_CLAUDE = new Map([['codex', REAL_KITS.get('codex')] as const]) as NonNullable<RuntimesFiles['kits']>;

/** Publish the fleet from `files` with only `kits` on, and say what was published. */
async function publish(kits: RuntimesFiles['kits']) {
  const assembled = assembleRuntimesModel(filesFor(kits));
  const applied: FleetApplyPlan[] = [];
  const logins = fakeLogins(LOGINS);
  const deps: FleetCatalogServiceDeps = {
    ...unavailableCatalogDeps(() => NOW, logins, fakeLoginChanges()),
    document: async () => ({
      format: 'present',
      model: assembled.model,
      revision: assembled.revision,
      unreadable: assembled.unreadable,
      stoodInLogins: assembled.stoodInLogins,
      documents: () => [],
    }),
    readAsset: async () => undefined,
    documentRevision: async () => 'absent',
    ids: async () => undefined,
    locate: () => '/usr/bin/tool',
    credentials: logins,
    loginChanges: fakeLoginChanges(),
    configWriter: { write: async () => undefined },
    layout: LAYOUT,
    claudeStatusline: () => "'fy' statusline",
    fyCommand: '/opt/ferretry/bin/fy',
    hostCodexHome: '/home/person/.codex',
    kits: () => (kits ?? new Map()) as never,
    modelCatalogs: async () => ({ signIn: REAL_SIGN_IN, catalogs: {} }) as never,
    provisioner: {
      preview: async plan => ({ ...plan, sharedHistory: [] }),
      apply: async plan => {
        applied.push(plan);
        return {
          accountCount: plan.manifest.accounts.length,
          operationCount: plan.operations.length,
          manifestPath: '/fy/fleet/manifest.json',
          prunedWrappers: [],
          sharedHistory: [],
        };
      },
    },
  };
  const result = await new FleetCatalogService(deps).publishFromFiles();
  return { assembled, result, accounts: applied[0]?.manifest.accounts ?? [] };
}

describe('a saved profile that layers Claude’s comfort settings, with Claude’s plugin off', () => {
  it('should know the comfort name, so no component is unreadable and no runtime is a stand-in', () => {
    const { model, unreadable } = assembleRuntimesModel(filesFor(NO_CLAUDE));

    expect(unreadable).toEqual([]);
    expect(Object.keys(model.components.settings ?? {})).toEqual(['ferretry-claude-comfort']);
  });

  it('should publish Codex available and Claude unavailable with the typed refusal, as with both plugins on', async () => {
    const off = await publish(NO_CLAUDE);

    expect(off.result).toBe('applied');
    expect(off.accounts.map(account => [account.kind, account.available])).toEqual([
      ['claude', false],
      ['codex', true],
    ]);
    expect(off.accounts.find(account => account.kind === 'claude')?.unavailableReason).toContain('not supported');

    const on = await publish(REAL_KITS);
    expect(on.accounts.map(account => [account.kind, account.available])).toEqual([
      ['claude', true],
      ['codex', true],
    ]);
  });
});
