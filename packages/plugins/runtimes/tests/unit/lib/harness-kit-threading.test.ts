/**
 * The kit a harness's own plugin hands Runtimes reaches every group a materialisation asks about that harness (E-276 PR 1):
 * each group function is given the kit of the runtime's own harness, and a harness whose plugin gives none is given none —
 * never another harness's. Claude's and Codex's MCP and document members are read now (E-276 PR 6, PR 7), so a Claude runtime without its kit is
 * published UNAVAILABLE by name instead of written in another shape, and the rest of the plan still publishes; the same holds
 * for a Codex runtime whose plugin gives no kit (E-276 PR 7 documents, PR 12 extras, PR 9 launch line), whatever its credential store.
 *
 * It is also the startup order: the settings sources can answer `unavailable` while plugins are still starting, so the
 * kit is read live with each plan and the first plan after a source comes online carries it.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import {
  ProfileClaudeSettingsSource,
  ProfileCodexSettingsSource,
  type ProfileComponentSource,
  type RuntimesHarnessKit,
} from '../../../contract/index.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import type { FleetApplyPlan } from '../../../daemon/lib/provisioning.ts';
import { harnessKits } from '../../../daemon/adapters/profile-components.ts';
import { installGroupSpies } from '../../support/group-spies.ts';
import { REAL_KITS } from '../../support/real-kits.ts';

const spies = installGroupSpies();
afterAll(spies.restore);

const { twoHarnessWorld, wrapperText } = await import('../../support/two-harness-world.ts');

const accountOf = (accounts: readonly { readonly displayName: string }[], name: string) => {
  const found = accounts.find(account => account.displayName === name);
  if (found === undefined) throw new Error(`no account ${name}`);
  return found as typeof found & {
    readonly available: boolean;
    readonly unavailableReason: string | null;
    readonly home: string;
  };
};

const CLAUDE_KIT = REAL_KITS.get('claude') as RuntimesHarnessKit;
const CODEX_KIT = REAL_KITS.get('codex') as RuntimesHarnessKit;
const GROUPS = ['fixedLayerOf', 'plumbingOf', 'priorServersOf', 'runtimeExtras', 'autonomousPreparation'] as const;

const source = (kit: RuntimesHarnessKit): ProfileComponentSource => ({
  list: async () => [],
  read: async () => undefined,
  kit,
});

const kitsOf = (group: (typeof GROUPS)[number], harness: string): (RuntimesHarnessKit | undefined)[] =>
  spies.calls.filter(call => call.group === group && call.harness === harness).map(call => call.kit);

describe('the kit threaded to the groups of a materialisation', () => {
  it('should hand every group the kit of the runtime own harness, and nothing else', async () => {
    spies.calls.length = 0;
    const kits = new Map([
      ['claude', CLAUDE_KIT],
      ['codex', CODEX_KIT],
    ] as const);
    const { service } = twoHarnessWorld({ kits: () => kits });
    await service.publishFromFiles();
    for (const group of GROUPS) {
      expect(kitsOf(group, 'claude')[0]).toBe(CLAUDE_KIT);
      expect(kitsOf(group, 'codex')[0]).toBe(CODEX_KIT);
    }
  });

  it('should hand a harness whose plugin gives no kit no kit, never another harness one, and publish only its runtime unavailable', async () => {
    spies.calls.length = 0;
    const { service, plans } = twoHarnessWorld({ kits: () => new Map([['codex', CODEX_KIT]] as const) });
    await expect(service.publishFromFiles()).resolves.toBe('applied');
    expect(kitsOf('plumbingOf', 'claude')).toEqual([undefined]);
    expect(kitsOf('plumbingOf', 'codex').every(kit => kit === CODEX_KIT)).toBe(true);
    const accounts = plans[0]?.manifest.accounts ?? [];
    expect(accountOf(accounts, 'claude-default')).toMatchObject({
      available: false,
      unavailableReason: expect.stringContaining('claude-code is not supported here'),
    });
    expect(accountOf(accounts, 'codex-default').unavailableReason ?? '').not.toContain('is not supported here');
    expect(wrapperText(plans[0] as FleetApplyPlan, 'codex-default')).not.toContain('is not supported here');
    expect(wrapperText(plans[0] as FleetApplyPlan, 'claude-default')).toContain('is not supported here');
  });

  it('should make an environment-backed Claude runtime unavailable runtime-wide when its plugin gives no kit', async () => {
    const model = parseAccountModel({
      version: 1,
      credentials: {
        'claude-key': { harness: 'claude', store: 'environment', env: { ANTHROPIC_API_KEY: 'sk-synthetic-not-a-key' } },
        'codex-you': { harness: 'codex', store: 'host' },
      },
      components: { instructions: { notes: { file: 'components/instructions/notes.md' } } },
      profiles: { default: { layers: ['instructions/notes'] } },
      runtimes: {
        'claude-env': { credential: 'claude-key', profile: 'default' },
        'codex-default': { credential: 'codex-you', profile: 'default' },
      },
    });
    const { service, plans } = twoHarnessWorld({
      kits: () => new Map([['codex', CODEX_KIT]] as const),
      document: async () => ({
        format: 'present',
        model,
        revision: 'rev-1',
        unreadable: [],
        stoodInLogins: [],
        documents: () => [],
      }),
    });
    await expect(service.publishFromFiles()).resolves.toBe('applied');
    const plan = plans[0] as FleetApplyPlan;
    expect(accountOf(plan.manifest.accounts, 'claude-env')).toMatchObject({
      available: false,
      unavailableReason: 'claude-code is not supported here',
    });
    expect(wrapperText(plan, 'claude-env')).toContain('claude-code is not supported here');
    expect(wrapperText(plan, 'codex-default')).toContain('codex-default');
  });

  it('should write nothing into the home of a Claude runtime whose plugin gives no kit', async () => {
    const { service, plans } = twoHarnessWorld({ kits: () => new Map([['codex', CODEX_KIT]] as const) });
    await service.publishFromFiles();
    const claudeHome = accountOf(plans[0]?.manifest.accounts ?? [], 'claude-default').home;
    const written = (plans[0]?.operations ?? []).filter(
      operation => 'path' in operation && operation.path.startsWith(`${claudeHome}/`),
    );
    expect(written).toEqual([]);
  });

  it('should make a Codex runtime unavailable by name when its plugin gives no kit, and only that runtime', async () => {
    spies.calls.length = 0;
    const { service, plans } = twoHarnessWorld({ kits: () => new Map([['claude', CLAUDE_KIT]] as const) });
    await expect(service.publishFromFiles()).resolves.toBe('applied');
    expect(kitsOf('plumbingOf', 'codex')).toEqual([undefined]);
    expect(kitsOf('plumbingOf', 'claude').every(kit => kit === CLAUDE_KIT)).toBe(true);
    const accounts = plans[0]?.manifest.accounts ?? [];
    expect(accountOf(accounts, 'codex-default')).toMatchObject({
      available: false,
      unavailableReason: expect.stringContaining('codex is not supported here'),
    });
    expect(accountOf(accounts, 'claude-default').unavailableReason ?? '').not.toContain('is not supported here');
    expect(wrapperText(plans[0] as FleetApplyPlan, 'codex-default')).toContain('is not supported here');
    expect(wrapperText(plans[0] as FleetApplyPlan, 'claude-default')).not.toContain('is not supported here');
  });

  it('should make an environment-backed Codex runtime unavailable runtime-wide when its plugin gives no kit', async () => {
    const model = parseAccountModel({
      version: 1,
      credentials: {
        'codex-key': { harness: 'codex', store: 'environment', env: { OPENAI_API_KEY: 'sk-synthetic-not-a-key' } },
        'claude-you': { harness: 'claude', store: 'host' },
      },
      components: { instructions: { notes: { file: 'components/instructions/notes.md' } } },
      profiles: { default: { layers: ['instructions/notes'] } },
      runtimes: {
        'codex-env': { credential: 'codex-key', profile: 'default' },
        'claude-default': { credential: 'claude-you', profile: 'default' },
      },
    });
    const { service, plans } = twoHarnessWorld({
      kits: () => new Map([['claude', CLAUDE_KIT]] as const),
      document: async () => ({
        format: 'present',
        model,
        revision: 'rev-1',
        unreadable: [],
        stoodInLogins: [],
        documents: () => [],
      }),
    });
    await expect(service.publishFromFiles()).resolves.toBe('applied');
    const plan = plans[0] as FleetApplyPlan;
    expect(accountOf(plan.manifest.accounts, 'codex-env')).toMatchObject({
      available: false,
      unavailableReason: 'codex is not supported here',
    });
    expect(wrapperText(plan, 'codex-env')).toContain('codex is not supported here');
    expect(wrapperText(plan, 'claude-default')).toContain('claude-default');
  });

  it.each([
    ['codex', 'codex-env', 'codex-key', 'OPENAI_API_KEY', 'claude', 'codex is not supported here'],
    ['claude', 'claude-env', 'claude-key', 'ANTHROPIC_API_KEY', 'codex', 'claude-code is not supported here'],
  ] as const)(
    'should append the kitless reason of an environment-backed %s runtime exactly once, in the manifest and the wrapper',
    async (harness, runtimeName, credentialName, variable, otherKit, reason) => {
      const model = parseAccountModel({
        version: 1,
        credentials: {
          [credentialName]: { harness, store: 'environment', env: { [variable]: 'sk-synthetic-not-a-key' } },
        },
        components: { instructions: { notes: { file: 'components/instructions/notes.md' } } },
        profiles: { default: { layers: ['instructions/notes'] } },
        runtimes: { [runtimeName]: { credential: credentialName, profile: 'default' } },
      });
      const { service, plans } = twoHarnessWorld({
        kits: () => new Map([[otherKit, otherKit === 'claude' ? CLAUDE_KIT : CODEX_KIT]] as const),
        document: async () => ({
          format: 'present',
          model,
          revision: 'rev-1',
          unreadable: [],
          stoodInLogins: [],
          documents: () => [],
        }),
      });
      await expect(service.publishFromFiles()).resolves.toBe('applied');
      const plan = plans[0] as FleetApplyPlan;
      const occurrences = (text: string) => text.split(reason).length - 1;
      const published = accountOf(plan.manifest.accounts, runtimeName);
      expect(published.available).toBe(false);
      expect(occurrences(published.unavailableReason ?? '')).toBe(1);
      expect(occurrences(wrapperText(plan, runtimeName))).toBe(1);
    },
  );

  it('should write nothing into the home of a Codex runtime whose plugin gives no kit', async () => {
    const { service, plans } = twoHarnessWorld({ kits: () => new Map([['claude', CLAUDE_KIT]] as const) });
    await service.publishFromFiles();
    const codexHome = accountOf(plans[0]?.manifest.accounts ?? [], 'codex-default').home;
    const written = (plans[0]?.operations ?? []).filter(
      operation => 'path' in operation && operation.path.startsWith(`${codexHome}/`),
    );
    expect(written).toEqual([]);
  });

  it('should hand no group a kit when nothing supplies kits, and refuse each runtime on its own', async () => {
    spies.calls.length = 0;
    const { service, plans } = twoHarnessWorld({ kits: undefined });
    await expect(service.publishFromFiles()).resolves.toBe('applied');
    expect(spies.calls.length).toBeGreaterThan(0);
    expect(spies.calls.every(call => call.kit === undefined)).toBe(true);
    const accounts = plans[0]?.manifest.accounts ?? [];
    expect(accountOf(accounts, 'claude-default').available).toBe(false);
    // Every runtime of a harness without its kit is refused on its own, and each is still listed with a wrapper that says why.
    expect(accountOf(accounts, 'codex-default').unavailableReason).toContain('codex is not supported here');
    expect(wrapperText(plans[0] as FleetApplyPlan, 'codex-default')).toContain('is not supported here');
  });

  it('should give the first plan after a settings source comes online the kit, and the plan before it none', async () => {
    spies.calls.length = 0;
    let online = false;
    const { service, plans } = twoHarnessWorld({
      kits: () =>
        harnessKits(hook => {
          if (!online) return 'unavailable';
          return hook === ProfileClaudeSettingsSource
            ? source(CLAUDE_KIT)
            : hook === ProfileCodexSettingsSource
              ? source(CODEX_KIT)
              : 'unavailable';
        }),
    });
    await service.publishFromFiles();
    expect(kitsOf('plumbingOf', 'claude')).toEqual([undefined]);
    expect(accountOf(plans[0]?.manifest.accounts ?? [], 'claude-default').available).toBe(false);
    online = true;
    await service.publishFromFiles();
    expect(accountOf(plans.at(-1)?.manifest.accounts ?? [], 'claude-default').unavailableReason ?? '').not.toContain(
      'is not supported here',
    );
    for (const group of GROUPS) {
      expect(kitsOf(group, 'claude').at(-1)).toBe(CLAUDE_KIT);
      expect(kitsOf(group, 'codex').at(-1)).toBe(CODEX_KIT);
    }
  });
});

describe('a Codex runtime without its plugin kit', () => {
  const environmentWorld = (kits: () => ReadonlyMap<'claude' | 'codex', RuntimesHarnessKit>) => {
    const model = parseAccountModel({
      version: 1,
      credentials: {
        'claude-you': { harness: 'claude', store: 'environment', env: { ANTHROPIC_API_KEY: 'sk-synthetic-not-a-key' } },
        'codex-key': { harness: 'codex', store: 'environment', env: { OPENAI_API_KEY: 'sk-synthetic-not-a-key' } },
      },
      components: { instructions: { notes: { file: 'components/instructions/notes.md' } } },
      profiles: { default: { layers: ['instructions/notes'] } },
      runtimes: {
        'claude-env': { credential: 'claude-you', profile: 'default' },
        'codex-env': { credential: 'codex-key', profile: 'default' },
      },
    });
    return twoHarnessWorld({
      kits,
      document: async () => ({
        format: 'present',
        model,
        revision: 'rev-1',
        unreadable: [],
        stoodInLogins: [],
        documents: () => [],
      }),
    });
  };

  it('should be unavailable runtime-wide with the typed refusal, whatever its credential store, while Claude publishes', async () => {
    const { service, plans } = environmentWorld(() => new Map([['claude', CLAUDE_KIT]] as const));
    await expect(service.publishFromFiles()).resolves.toBe('applied');
    const plan = plans[0] as FleetApplyPlan;
    expect(accountOf(plan.manifest.accounts, 'codex-env')).toMatchObject({
      available: false,
      unavailableReason: 'codex is not supported here',
    });
    expect(wrapperText(plan, 'codex-env')).toContain('codex is not supported here');
    // Claude is not held back by Codex's missing kit (a runtime with no model of its own says that, not this).
    expect(accountOf(plan.manifest.accounts, 'claude-env').unavailableReason ?? '').not.toContain(
      'is not supported here',
    );
  });

  it('should schedule no operation in its home, so a catalog file recorded there is never swept', async () => {
    const { service, plans } = environmentWorld(() => new Map([['claude', CLAUDE_KIT]] as const));
    await service.publishFromFiles();
    const plan = plans[0] as FleetApplyPlan;
    const codexHome = accountOf(plan.manifest.accounts, 'codex-env').home;
    const touching = plan.operations.filter(
      operation => 'path' in operation && (operation.path === codexHome || operation.path.startsWith(`${codexHome}/`)),
    );
    expect(touching).toEqual([]);
    // The planned Claude home is still written: only the kitless runtime is held back.
    const claudeHome = accountOf(plan.manifest.accounts, 'claude-env').home;
    expect(plan.operations.some(operation => 'path' in operation && operation.path.startsWith(`${claudeHome}/`))).toBe(
      true,
    );
  });

  it('should refuse a Codex runtime whose kit gives no fixed layer the same way, once, and never as an auto refusal', async () => {
    const { service, plans } = environmentWorld(
      () =>
        new Map<'claude' | 'codex', RuntimesHarnessKit>([
          ['claude', CLAUDE_KIT],
          ['codex', { command: 'codex', runtimeExtras: () => ({ env: {} }) }],
        ]),
    );
    await service.publishFromFiles();
    const account = accountOf((plans[0] as FleetApplyPlan).manifest.accounts, 'codex-env');
    expect(account.available).toBe(false);
    expect(account.unavailableReason).toBe('codex is not supported here');
    expect('autoRefusal' in account && account.autoRefusal).toBeFalsy();
  });

  it('should refuse a Codex runtime whose kit gives no extras the same way', async () => {
    const { service, plans } = environmentWorld(
      () =>
        new Map<'claude' | 'codex', RuntimesHarnessKit>([
          ['claude', CLAUDE_KIT],
          ['codex', { command: 'codex' }],
        ]),
    );
    await service.publishFromFiles();
    expect(accountOf((plans[0] as FleetApplyPlan).manifest.accounts, 'codex-env').unavailableReason).toBe(
      'codex is not supported here',
    );
  });
});
