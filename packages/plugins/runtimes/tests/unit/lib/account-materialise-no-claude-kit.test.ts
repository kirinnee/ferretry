/**
 * A Claude runtime whose plugin gives no kit is REFUSED by name (`claude-code is not supported here`), runtime-wide and
 * never by a throw, so a fleet with only the Codex kit still publishes Codex (E-276 PR 8, review r1 MUST 2). The Claude
 * login here is ENVIRONMENT-backed: no store of the plugin's is asked about, so only the launch line is missing.
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
  defaultHomeDirectories: ['/home/person/.claude', '/home/person/.codex'],
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

describe('a Claude runtime whose plugin gives no kit', () => {
  const codexOnly = new Map([['codex', REAL_KITS.get('codex') as RuntimesHarnessKit]] as const);

  it('should publish the plan, refuse only that runtime by name, and write its wrapper as a refusal', () => {
    const result = plan(codexOnly);
    const rows = Object.fromEntries(result.manifest.accounts.map(row => [row.displayName, row]));
    expect(rows['claude-env']).toMatchObject({
      available: false,
      unavailableReason: 'claude-code is not supported here',
    });
    expect(rows['codex-env']?.available).toBe(true);
    const claude = wrapperOf(result, 'claude-env');
    expect(claude).toContain('claude-env cannot start: claude-code is not supported here');
    expect(claude).toContain('exit 1');
  });

  it('should write the Codex runtime exactly as a fleet with both kits does', () => {
    expect(wrapperOf(plan(codexOnly), 'codex-env')).toBe(wrapperOf(plan(REAL_KITS), 'codex-env'));
  });

  it('should refuse a Claude kit that gives no launch line, by name, and still publish Codex', () => {
    const noLaunchLine = new Map([
      ['claude', {} as RuntimesHarnessKit],
      ['codex', REAL_KITS.get('codex') as RuntimesHarnessKit],
    ] as const);
    const result = plan(noLaunchLine);
    const rows = Object.fromEntries(result.manifest.accounts.map(row => [row.displayName, row]));
    expect(rows['claude-env']).toMatchObject({
      available: false,
      unavailableReason: 'claude-code is not supported here',
    });
    expect(rows['codex-env']?.available).toBe(true);
  });

  it('should refuse the same way when no kits are supplied at all', () => {
    const rows = plan(undefined).manifest.accounts;
    expect(rows.find(row => row.displayName === 'claude-env')?.unavailableReason).toBe(
      'claude-code is not supported here',
    );
  });
});
