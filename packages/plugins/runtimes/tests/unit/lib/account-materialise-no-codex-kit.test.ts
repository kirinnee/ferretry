/**
 * A Codex runtime whose plugin gives no kit is REFUSED by name (`codex is not supported here`), runtime-wide and never by a
 * throw, so a fleet with only the Claude kit still publishes Claude (E-276 PR 9, addendum 12). The Codex login here is
 * ENVIRONMENT-backed: no store of the plugin's is asked about, so only the launch line is missing.
 */
import { describe, expect, it } from 'bun:test';
import type { RuntimesHarnessKit } from '../../../contract/index.ts';
import { EMPTY_RUNTIME_IDS } from '../../../daemon/lib/account/ids.ts';
import { materialiseFleet } from '../../../daemon/lib/account/materialise.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import type { FleetLayout } from '../../../daemon/lib/provisioning.ts';
import { REAL_KITS } from '../../support/real-kits.ts';

const LAYOUT: FleetLayout = {
  stateHome: '/fy',
  userHome: '/home/person',
  fleetDirectory: '/fy/fleet',
  binDirectory: '/fy/fleet/bin',
  homesDirectory: '/fy/fleet/homes',
  assetsDirectory: '/fy/fleet/assets',
  manifestPath: '/fy/fleet/manifest.json',
  defaultHomeDirectories: { claude: '/home/person/.claude', codex: '/home/person/.codex' },
};

const MODEL = parseAccountModel({
  version: 1,
  credentials: {
    'claude-env': { harness: 'claude', store: 'environment', env: { ANTHROPIC_API_KEY: '${secret:SYNTH_KEY}' } },
    'codex-env': { harness: 'codex', store: 'environment', env: { OPENAI_API_KEY: '${secret:SYNTH_OTHER}' } },
  },
  components: {
    modelSets: {
      claude: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' },
      codex: { models: ['gpt-6'], default: 'gpt-6' },
    },
  },
  profiles: { default: { layers: ['modelSets/claude', 'modelSets/codex'] } },
  runtimes: {
    'claude-env': { credential: 'claude-env', profile: 'default' },
    'codex-env': { credential: 'codex-env', profile: 'default' },
  },
});

const plan = (kits: ReadonlyMap<'claude' | 'codex', RuntimesHarnessKit> | undefined) =>
  materialiseFleet({
    model: MODEL,
    layout: LAYOUT,
    ids: EMPTY_RUNTIME_IDS,
    mint: (() => {
      const ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b'];
      return () => ids.shift() ?? 'exhausted';
    })(),
    generatedAt: '2026-10-13T08:00:00.000Z',
    claudeStatusline: () => "'fy' statusline",
    fyCommand: '/opt/ferretry/bin/fy',
    hostCodexHome: '/home/person/.codex',
    acceptsAutoPermissionMode: true,
    kits,
  });

const wrapperOf = (result: ReturnType<typeof plan>, name: string): string => {
  const operation = result.operations.find(candidate => candidate.path === `/fy/fleet/bin/${name}`);
  if (operation?.kind !== 'file') throw new Error(`no wrapper for ${name}`);
  return operation.content;
};

describe('a Codex runtime whose plugin gives no kit', () => {
  const claudeOnly = new Map([['claude', REAL_KITS.get('claude') as RuntimesHarnessKit]] as const);

  it('should publish the plan, refuse only that runtime by name, and write its wrapper as a refusal', () => {
    const result = plan(claudeOnly);
    const rows = Object.fromEntries(result.manifest.accounts.map(row => [row.displayName, row]));
    expect(rows['codex-env']).toMatchObject({ available: false, unavailableReason: 'codex is not supported here' });
    expect(rows['claude-env']?.available).toBe(true);
    const codex = wrapperOf(result, 'codex-env');
    expect(codex).toContain('codex-env cannot start: codex is not supported here');
    expect(codex).toContain('exit 1');
  });

  it('should write the Claude runtime exactly as a fleet with both kits does', () => {
    expect(wrapperOf(plan(claudeOnly), 'claude-env')).toBe(wrapperOf(plan(REAL_KITS), 'claude-env'));
  });

  it('should refuse a Codex kit that gives no launch line, by name, and still publish Claude', () => {
    const noLaunchLine = new Map([
      ['claude', REAL_KITS.get('claude') as RuntimesHarnessKit],
      ['codex', {} as RuntimesHarnessKit],
    ] as const);
    const rows = Object.fromEntries(plan(noLaunchLine).manifest.accounts.map(row => [row.displayName, row]));
    expect(rows['codex-env']).toMatchObject({ available: false, unavailableReason: 'codex is not supported here' });
    expect(rows['claude-env']?.available).toBe(true);
  });

  it('should refuse the same way when no kits are supplied at all', () => {
    const rows = plan(undefined).manifest.accounts;
    expect(rows.find(row => row.displayName === 'codex-env')?.unavailableReason).toBe('codex is not supported here');
  });
});
