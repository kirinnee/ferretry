/**
 * Claude's data words come from its own plugin's kit (E-276 PR 13): the command that starts it, the variable that points it at
 * its home, the skill folders it keeps for itself, and its fast-mode rule. Runtimes reads them; a Claude runtime whose kit gives
 * no command or home variable is published unavailable with the one typed `harness-unsupported` refusal (whatever its credential
 * store), and the rest of the fleet still publishes. Codex's words stay where they were until its own move.
 *
 * The tables that the frozen goldens still import (`HARNESS_OWNED_SKILL_ENTRIES`, `claudeFastSupport`) are pinned equal to the
 * kit's words here, so the two cannot drift while both exist.
 */
import { describe, expect, it } from 'bun:test';
import type { RuntimesHarnessKit } from '../../../contract/index.ts';
import { HARNESS_OWNED_SKILL_ENTRIES, ownedSkillEntriesOf } from '../../../daemon/lib/assets.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import type { FleetApplyPlan } from '../../../daemon/lib/provisioning.ts';
import { claudeFastSupport, fastSupportOf } from '../../../daemon/lib/service/foreign.ts';
import { REAL_KITS } from '../../support/real-kits.ts';
import { twoHarnessWorld, wrapperText } from '../../support/two-harness-world.ts';

const CLAUDE_KIT = REAL_KITS.get('claude') as RuntimesHarnessKit;
const CODEX_KIT = REAL_KITS.get('codex') as RuntimesHarnessKit;
const MODELS = [
  'claude-opus-5-5',
  'claude-opus-4-8',
  'Claude-OPUS-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'gpt-6',
  '',
];
const REFUSAL = 'claude-code is not supported here';

const without = (kit: RuntimesHarnessKit, member: keyof RuntimesHarnessKit): RuntimesHarnessKit =>
  Object.fromEntries(Object.entries(kit).filter(([key]) => key !== member)) as RuntimesHarnessKit;

const accountOf = (accounts: readonly { readonly displayName: string }[], name: string) => {
  const found = accounts.find(account => account.displayName === name);
  if (found === undefined) throw new Error(`no account ${name}`);
  return found as typeof found & { readonly available: boolean; readonly unavailableReason: string | null };
};

/** An ENVIRONMENT-backed Claude runtime beside a Codex one: the host-login path has its own refusal that hides a missing kit. */
const environmentWorld = (claudeKit: RuntimesHarnessKit | undefined) => {
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
  return twoHarnessWorld({
    kits: () =>
      new Map([...(claudeKit === undefined ? [] : ([['claude', claudeKit]] as const)), ['codex', CODEX_KIT] as const]),
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

describe("Claude's words, as its kit gives them", () => {
  it('should give the command, the home variable and the skill folders Claude keeps for itself', () => {
    expect(CLAUDE_KIT.command).toBe('claude');
    expect(CLAUDE_KIT.homeEnv).toBe('CLAUDE_CONFIG_DIR');
    expect(CLAUDE_KIT.ownedSkillEntries).toEqual([]);
  });

  it('should agree with the tables the frozen goldens still import, so the two cannot drift', () => {
    expect(CLAUDE_KIT.ownedSkillEntries).toEqual(HARNESS_OWNED_SKILL_ENTRIES.claude);
    for (const model of MODELS) expect(CLAUDE_KIT.fastSupport?.(model)).toBe(claudeFastSupport(model));
  });
});

describe('fast mode through the kit', () => {
  it('should say what the Claude kit says, and nothing when Claude gives no rule', () => {
    expect(fastSupportOf('claude', 'claude-opus-5-5', CLAUDE_KIT)).toEqual({ fast: true });
    expect(fastSupportOf('claude', 'claude-sonnet-5-5', CLAUDE_KIT)).toEqual({ fast: false });
    expect(fastSupportOf('claude', 'claude-opus-5-5', undefined)).toEqual({});
    expect(fastSupportOf('claude', 'claude-opus-5-5', without(CLAUDE_KIT, 'fastSupport'))).toEqual({});
  });

  it('should never ask the Claude rule for another harness, whatever kit it is handed', () => {
    expect(fastSupportOf('codex', 'claude-opus-5-5', CLAUDE_KIT)).toEqual({});
    expect(fastSupportOf('codex', 'gpt-6', CODEX_KIT)).toEqual({});
  });
});

describe('the skill folders a harness keeps for itself', () => {
  it("should read Claude's from its kit and Codex's from the table, never one for the other", () => {
    expect(ownedSkillEntriesOf('claude', { ownedSkillEntries: ['.mine'] })).toEqual(['.mine']);
    expect(ownedSkillEntriesOf('claude', CLAUDE_KIT)).toEqual([]);
    expect(ownedSkillEntriesOf('claude', undefined)).toEqual([]);
    expect(ownedSkillEntriesOf('codex', CLAUDE_KIT)).toEqual(['.system']);
    expect(ownedSkillEntriesOf('codex', { ownedSkillEntries: ['.mine'] })).toEqual(['.system']);
  });
});

describe('the launch line through the kit words', () => {
  it("should write the command and home variable the Claude kit gives, and Codex's own as before", async () => {
    const kit: RuntimesHarnessKit = { ...CLAUDE_KIT, command: 'claude-alt', homeEnv: 'ALT_CLAUDE_HOME' };
    const { service, plans } = twoHarnessWorld({
      kits: () =>
        new Map([
          ['claude', kit],
          ['codex', CODEX_KIT],
        ] as const),
    });
    await expect(service.publishFromFiles()).resolves.toBe('applied');
    const plan = plans[0] as FleetApplyPlan;
    const claude = wrapperText(plan, 'claude-default');
    expect(claude).toContain('export ALT_CLAUDE_HOME=');
    expect(claude).toContain('claude-alt');
    expect(claude).not.toContain('CLAUDE_CONFIG_DIR=');
    expect(wrapperText(plan, 'codex-default')).toContain('export CODEX_HOME=');
  });
});

describe('a Claude runtime whose kit gives no command or home variable', () => {
  it.each(['command', 'homeEnv'] as const)(
    'should be unavailable runtime-wide with the typed refusal when the kit gives no %s, and only that runtime',
    async member => {
      const { service, plans } = environmentWorld(without(CLAUDE_KIT, member));
      await expect(service.publishFromFiles()).resolves.toBe('applied');
      const plan = plans[0] as FleetApplyPlan;
      expect(accountOf(plan.manifest.accounts, 'claude-env')).toMatchObject({
        available: false,
        unavailableReason: REFUSAL,
      });
      expect(wrapperText(plan, 'claude-env')).toContain(REFUSAL);
      expect(accountOf(plan.manifest.accounts, 'codex-default').unavailableReason ?? '').not.toContain(
        'is not supported here',
      );
    },
  );

  it('should be unavailable the same way, in a host-login runtime, when the kit gives no command', async () => {
    const { service, plans } = twoHarnessWorld({
      kits: () =>
        new Map([
          ['claude', without(CLAUDE_KIT, 'command')],
          ['codex', CODEX_KIT],
        ] as const),
    });
    await expect(service.publishFromFiles()).resolves.toBe('applied');
    expect(accountOf((plans[0] as FleetApplyPlan).manifest.accounts, 'claude-default')).toMatchObject({
      available: false,
      unavailableReason: expect.stringContaining(REFUSAL),
    });
  });

  it('should be unavailable runtime-wide with only the OTHER kit present, an environment-backed runtime included', async () => {
    const { service, plans } = environmentWorld(undefined);
    await expect(service.publishFromFiles()).resolves.toBe('applied');
    const plan = plans[0] as FleetApplyPlan;
    expect(accountOf(plan.manifest.accounts, 'claude-env')).toMatchObject({
      available: false,
      unavailableReason: REFUSAL,
    });
    expect(accountOf(plan.manifest.accounts, 'codex-default').unavailableReason ?? '').not.toContain(
      'is not supported here',
    );
  });
});
