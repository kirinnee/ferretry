/**
 * A Claude runtime whose kit is absent, or whose kit gives no launch line, command or home variable, is refused by the ONE
 * runtime-wide `harness-unsupported` decision in EVERY credential store: environment, the person's own (host) home even when it
 * cannot be named, and a Ferretry-kept login with no sign-in file. Its login then has nothing further to say, nothing is
 * written into its home, both launch modes of its wrapper refuse, and Codex still publishes (E-276 PR 13, the Claude twin of
 * PR 9's Codex matrix).
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    'claude-host': { harness: 'claude', store: 'host' },
    'claude-kept': { harness: 'claude', store: 'ferretry' },
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
    'claude-host': { credential: 'claude-host', profile: 'default' },
    'claude-kept': { credential: 'claude-kept', profile: 'default' },
    'codex-env': { credential: 'codex-env', profile: 'default' },
  },
});

const CLAUDE_RUNTIMES = ['claude-env', 'claude-host', 'claude-kept'] as const;
/** The ids the plan mints, in runtime-name order. */
const CLAUDE_IDS = {
  'claude-env': '00000000-0000-4000-8000-000000000001',
  'claude-host': '00000000-0000-4000-8000-000000000002',
  'claude-kept': '00000000-0000-4000-8000-000000000003',
} as const;
const CODEX_ID = '00000000-0000-4000-8000-000000000004';

const plan = (kits: ReadonlyMap<'claude' | 'codex', RuntimesHarnessKit>) => {
  const ids = [1, 2, 3, 4].map(n => `00000000-0000-4000-8000-00000000000${n}`);
  return materialiseFleet({
    model: MODEL,
    layout: LAYOUT,
    ids: EMPTY_RUNTIME_IDS,
    mint: () => ids.shift() ?? 'exhausted',
    generatedAt: '2026-10-13T08:00:00.000Z',
    claudeStatusline: () => "'fy' statusline",
    fyCommand: '/opt/ferretry/bin/fy',
    acceptsAutoPermissionMode: true,
    // A Ferretry-kept login Logins knows, with no sign-in file.
    loginStores: [{ id: 'claude-kept', variables: {} }],
    kits,
  });
};

const wrapperOf = (result: ReturnType<typeof plan>, name: string): string => {
  const operation = result.operations.find(candidate => candidate.path === `/fy/fleet/bin/${name}`);
  if (operation?.kind !== 'file') throw new Error(`no wrapper for ${name}`);
  return operation.content;
};

const claude = REAL_KITS.get('claude') as RuntimesHarnessKit;
const codex = REAL_KITS.get('codex') as RuntimesHarnessKit;
const commandless = { ...claude, command: undefined } as RuntimesHarnessKit;
const homeless = { ...claude, homeEnv: undefined } as RuntimesHarnessKit;
const wrapperless = { ...claude, wrapper: undefined } as RuntimesHarnessKit;

describe.each([
  ['no Claude kit', new Map([['codex', codex]] as const)],
  [
    'a Claude kit with no command',
    new Map([
      ['claude', commandless],
      ['codex', codex],
    ] as const),
  ],
  [
    'a Claude kit with no home variable',
    new Map([
      ['claude', homeless],
      ['codex', codex],
    ] as const),
  ],
  [
    'a Claude kit with no launch line',
    new Map([
      ['claude', wrapperless],
      ['codex', codex],
    ] as const),
  ],
])('Claude with %s', (_label, kits) => {
  const result = plan(kits);
  const rows = Object.fromEntries(result.manifest.accounts.map(row => [row.displayName, row]));

  for (const name of CLAUDE_RUNTIMES) {
    it(`should refuse ${name} once, by name, whatever its login says (an environment one, the person's own home, or the kept login with no sign-in file)`, () => {
      expect(rows[name]?.available).toBe(false);
      expect(rows[name]?.unavailableReason).toBe('claude-code is not supported here');
      expect(rows[name]?.autoRefusal).toBeUndefined();
    });

    it(`should write nothing into ${name}'s home`, () => {
      const id = CLAUDE_IDS[name];
      expect(result.operations.filter(operation => operation.path.includes(`/homes/${id}`))).toEqual([]);
    });

    for (const mode of ['interactive', 'auto']) {
      it(`should exit 1 with the refusal when ${name} is started ${mode}`, () => {
        const directory = mkdtempSync(join(tmpdir(), 'fy-claude-refusal-'));
        try {
          const wrapper = join(directory, 'wrapper');
          writeFileSync(wrapper, wrapperOf(result, name));
          const run = Bun.spawnSync(['sh', wrapper], {
            env: { PATH: '/usr/bin:/bin', HOME: directory, FY_SESSION_MODE: mode },
          });
          expect(run.exitCode).toBe(1);
          const said = run.stderr.toString() + run.stdout.toString();
          expect(said).toContain('claude-code is not supported here');
          expect(said).not.toContain('login');
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }

  it('should still publish Codex, written as it is with both kits', () => {
    expect(rows['codex-env']?.available).toBe(true);
    expect(result.operations.some(operation => operation.path.includes(`/homes/${CODEX_ID}`))).toBe(true);
    expect(wrapperOf(result, 'codex-env')).toBe(wrapperOf(plan(REAL_KITS), 'codex-env'));
  });
});
