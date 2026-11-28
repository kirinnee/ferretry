/**
 * The kit a harness's own plugin hands Runtimes reaches every group a materialisation asks about that harness (E-276 PR 1):
 * each group function is given the kit of the runtime's own harness, and a harness whose plugin gives none is given none —
 * never another harness's. Claude's MCP and document members are read now (E-276 PR 6), so a Claude runtime without its kit is
 * REFUSED by name instead of written in another shape; Codex still branches in Runtimes, so its fake kit is only handed through.
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
import { harnessKits } from '../../../daemon/adapters/profile-components.ts';
import type { FleetApplyPlan } from '../../../daemon/lib/provisioning.ts';
import { installGroupSpies } from '../../support/group-spies.ts';
import { REAL_KITS } from '../../support/real-kits.ts';

const spies = installGroupSpies();
afterAll(spies.restore);

const { twoHarnessWorld } = await import('../../support/two-harness-world.ts');

const CLAUDE_KIT = REAL_KITS.get('claude') as RuntimesHarnessKit;
const CODEX_KIT: RuntimesHarnessKit = { command: 'codex' };
/** Why a runtime of the last published plan cannot start, or `undefined` when it can. */
const blockedOf = (plan: FleetApplyPlan | undefined, runtime: string): string | undefined =>
  plan?.manifest.accounts.find(account => account.displayName === runtime)?.unavailableReason ?? undefined;

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

  it('should hand a harness whose plugin gives no kit no kit, never another harness one, and refuse its runtime', async () => {
    spies.calls.length = 0;
    const { service, plans } = twoHarnessWorld({ kits: () => new Map([['codex', CODEX_KIT]] as const) });
    await service.publishFromFiles();
    expect(blockedOf(plans.at(-1), 'claude-default')).toContain('claude-code is not supported here');
    expect(blockedOf(plans.at(-1), 'codex-default') ?? '').not.toContain('not supported here');
    expect(kitsOf('plumbingOf', 'claude')).toEqual([undefined]);
    expect(kitsOf('plumbingOf', 'codex').every(kit => kit === CODEX_KIT)).toBe(true);
  });

  it('should hand no group a kit when nothing supplies kits', async () => {
    spies.calls.length = 0;
    const { service, plans } = twoHarnessWorld({ kits: undefined });
    await service.publishFromFiles();
    expect(blockedOf(plans.at(-1), 'claude-default')).toContain('claude-code is not supported here');
    expect(spies.calls.length).toBeGreaterThan(0);
    expect(spies.calls.every(call => call.kit === undefined)).toBe(true);
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
    expect(blockedOf(plans.at(-1), 'claude-default')).toContain('claude-code is not supported here');
    expect(kitsOf('plumbingOf', 'claude')).toEqual([undefined]);
    online = true;
    await service.publishFromFiles();
    expect(blockedOf(plans.at(-1), 'claude-default') ?? '').not.toContain('not supported here');
    for (const group of GROUPS) {
      expect(kitsOf(group, 'claude').at(-1)).toBe(CLAUDE_KIT);
      expect(kitsOf(group, 'codex').at(-1)).toBe(CODEX_KIT);
    }
  });
});
