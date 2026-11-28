/**
 * A Codex runtime whose kit gives no command, no home variable or no list of the skill folders Codex keeps for itself is refused
 * by the ONE runtime-wide `harness-unsupported` decision in EVERY credential store: environment, the person's own (host) home
 * even when it cannot be named, and a Ferretry-kept login with no sign-in file; also when auto permission mode is unsupported,
 * where it never has a second (auto) reason. Its login then has nothing further to say, nothing is written into its home, both launch
 * modes of its wrapper refuse, and Claude still publishes (E-276 PR 14, the Codex twin of PR 13's Claude matrix).
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
  defaultHomeDirectories: ['/home/person/.claude', '/home/person/.codex'],
};

const BASE_MODEL = {
  version: 1,
  credentials: {
    'claude-env': { harness: 'claude', store: 'environment', env: { ANTHROPIC_API_KEY: '${secret:SYNTH_KEY}' } },
    'codex-env': { harness: 'codex', store: 'environment', env: { OPENAI_API_KEY: '${secret:SYNTH_OTHER}' } },
    'codex-host': { harness: 'codex', store: 'host' },
    'codex-kept': { harness: 'codex', store: 'ferretry' },
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
    'codex-host': { credential: 'codex-host', profile: 'default' },
    'codex-kept': { credential: 'codex-kept', profile: 'default' },
  },
};
const MODEL = parseAccountModel(BASE_MODEL);
/** The same fleet where agents run in auto permission mode, which the harness build here cannot honour. */
const AUTO_MODEL = parseAccountModel({ ...BASE_MODEL, machine: { agentPermissions: 'auto' } });

const CODEX_RUNTIMES = ['codex-env', 'codex-host', 'codex-kept'] as const;
/** The ids the plan mints, in runtime-name order (claude-env gets ...01). */
const CODEX_IDS = {
  'codex-env': '00000000-0000-4000-8000-000000000002',
  'codex-host': '00000000-0000-4000-8000-000000000003',
  'codex-kept': '00000000-0000-4000-8000-000000000004',
} as const;

const plan = (kits: ReadonlyMap<'claude' | 'codex', RuntimesHarnessKit>, autoUnsupported = false) => {
  const ids = [1, 2, 3, 4].map(n => `00000000-0000-4000-8000-00000000000${n}`);
  return materialiseFleet({
    model: autoUnsupported ? AUTO_MODEL : MODEL,
    layout: LAYOUT,
    ids: EMPTY_RUNTIME_IDS,
    mint: () => ids.shift() ?? 'exhausted',
    generatedAt: '2026-10-13T08:00:00.000Z',
    claudeStatusline: () => "'fy' statusline",
    fyCommand: '/opt/ferretry/bin/fy',
    acceptsAutoPermissionMode: !autoUnsupported,
    // A Ferretry-kept login Logins knows, with no sign-in file. The person's own Codex home is not named, so a host login is unreachable.
    loginStores: [{ id: 'codex-kept', variables: {} }],
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
const commandless = { ...codex, command: undefined } as RuntimesHarnessKit;
const homeless = { ...codex, homeEnv: undefined } as RuntimesHarnessKit;
const skillless = { ...codex, ownedSkillEntries: undefined } as RuntimesHarnessKit;

const PARTIAL_KITS = [
  ['a Codex kit with no command', commandless],
  ['a Codex kit with no home variable', homeless],
  ['a Codex kit with no list of its own skill folders', skillless],
] as const;

describe.each(PARTIAL_KITS)('Codex with %s', (_label, partial) => {
  const result = plan(
    new Map([
      ['claude', claude],
      ['codex', partial],
    ] as const),
  );
  const rows = Object.fromEntries(result.manifest.accounts.map(row => [row.displayName, row]));

  for (const name of CODEX_RUNTIMES) {
    it(`should refuse ${name} once, by name, whatever its login says`, () => {
      expect(rows[name]?.available).toBe(false);
      expect(rows[name]?.unavailableReason).toBe('codex is not supported here');
      expect(rows[name]?.autoRefusal).toBeUndefined();
    });

    it(`should write nothing into ${name}'s home`, () => {
      const id = CODEX_IDS[name];
      expect(result.operations.filter(operation => operation.path.includes(`/homes/${id}`))).toEqual([]);
    });

    for (const mode of ['interactive', 'auto']) {
      it(`should exit 1 with the refusal when ${name} is started ${mode}`, () => {
        const directory = mkdtempSync(join(tmpdir(), 'fy-codex-words-refusal-'));
        try {
          const wrapper = join(directory, 'wrapper');
          writeFileSync(wrapper, wrapperOf(result, name));
          const run = Bun.spawnSync(['sh', wrapper], {
            env: { PATH: '/usr/bin:/bin', HOME: directory, FY_SESSION_MODE: mode },
          });
          expect(run.exitCode).toBe(1);
          const said = run.stderr.toString() + run.stdout.toString();
          expect(said).toContain('codex is not supported here');
          expect(said).not.toContain('login');
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }

  it('should still publish Claude, written as it is with both kits', () => {
    expect(rows['claude-env']?.available).toBe(true);
    expect(wrapperOf(result, 'claude-env')).toBe(wrapperOf(plan(REAL_KITS), 'claude-env'));
  });
});

describe.each([
  ['no Codex kit', new Map([['claude', claude]] as const)],
  ...PARTIAL_KITS.map(
    ([label, partial]) =>
      [
        label,
        new Map([
          ['claude', claude],
          ['codex', partial],
        ] as const),
      ] as const,
  ),
])('Codex with %s, when auto permission mode is also unsupported', (_label, kits) => {
  const result = plan(kits, true);
  const rows = Object.fromEntries(result.manifest.accounts.map(row => [row.displayName, row]));

  for (const name of CODEX_RUNTIMES) {
    it(`should give ${name} the one runtime-wide reason and no auto refusal`, () => {
      expect(rows[name]?.available).toBe(false);
      expect(rows[name]?.unavailableReason).toBe('codex is not supported here');
      expect(rows[name]?.autoRefusal).toBeUndefined();
    });
  }

  it('should leave a Codex runtime whose kit is whole available, so only the missing word refuses it', () => {
    const whole = plan(REAL_KITS, true).manifest.accounts.find(row => row.displayName === 'codex-env');
    expect(whole?.available).toBe(true);
  });
});
