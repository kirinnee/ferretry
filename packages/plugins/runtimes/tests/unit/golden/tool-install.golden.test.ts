/**
 * E-276 0a: tool-install plans — which package manager each harness is installed with on each platform, the exact command shown
 * to the person, and how a run ends (installed, needs admin, timed out, could not start, not found after it) for both harnesses.
 * Nothing runs: the manager is a recording stub, and the locator and executable resolver are tables.
 */
import { describe, it } from 'bun:test';
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import type { HarnessKind } from '../../../daemon/lib/manifest.ts';
import { ToolInstallService } from '../../../daemon/lib/service/tool-install.ts';
import { expectGolden } from './support/golden.ts';

const OWNER: CallerGovernance = { governed: false, decide: () => ({ allowed: true, refusal: 'granted' as const }) };
type Options = ConstructorParameters<typeof ToolInstallService>[0];
type Run = Parameters<Options['run']>[0];
type RunResult = Awaited<ReturnType<Options['run']>>;

const HARNESSES: readonly HarnessKind[] = ['claude', 'codex'];

interface World {
  readonly platform: string;
  readonly onPath?: Readonly<Record<string, string>>;
  readonly runnable?: readonly string[];
  readonly found?: readonly HarnessKind[];
  readonly foundAfterRun?: readonly HarnessKind[];
  readonly result?: RunResult;
}

function service(world: World) {
  const runs: Run[] = [];
  const ran = new Set<string>();
  const built = new ToolInstallService({
    platform: world.platform,
    executables: { resolve: name => world.onPath?.[name], runnable: path => world.runnable?.includes(path) ?? false },
    locate: harness =>
      world.found?.includes(harness) || (ran.has(harness) && world.foundAfterRun?.includes(harness))
        ? { kind: harness, outcome: 'located', path: `/bin/${harness}` }
        : { kind: harness, outcome: 'absent', searched: [] },
    environment: { PATH: '/usr/bin' },
    timeoutMinutes: 15,
    run: async run => {
      runs.push(run);
      for (const harness of HARNESSES)
        if (run.args.some(arg => arg.includes(harness) || arg.includes(harness === 'claude' ? 'anthropic' : 'openai')))
          ran.add(harness);
      return world.result ?? { kind: 'exited', code: 0, tail: [] };
    },
  });
  return { built, runs };
}

const PLAN_WORLDS: Readonly<Record<string, World>> = {
  'darwin-brew-and-npm': { platform: 'darwin', onPath: { brew: '/opt/x/brew', npm: '/opt/x/npm' } },
  'darwin-npm-only': { platform: 'darwin', onPath: { npm: '/opt/x/npm' } },
  'darwin-homebrew-prefix': { platform: 'darwin', runnable: ['/opt/homebrew/bin/brew'] },
  'darwin-nothing': { platform: 'darwin' },
  'linux-apt-and-npm': { platform: 'linux', onPath: { 'apt-get': '/usr/bin/apt-get', npm: '/usr/bin/npm' } },
  'linux-npm-only': { platform: 'linux', onPath: { npm: '/usr/bin/npm' } },
  'linux-nothing': { platform: 'linux' },
  'win32-npm': { platform: 'win32', onPath: { npm: 'C:/npm' } },
  'claude-already-installed': { platform: 'darwin', onPath: { brew: '/opt/x/brew' }, found: ['claude'] },
};

const RUN_RESULTS: Readonly<Record<string, RunResult>> = {
  installed: { kind: 'exited', code: 0, tail: ['added 1 package'] },
  'needs-admin': { kind: 'exited', code: 243, tail: ['npm ERR! code EACCES', 'npm ERR! permission denied'] },
  failed: { kind: 'exited', code: 1, tail: ['something broke'] },
  'timed-out': { kind: 'timed-out', tail: ['still downloading'] },
  'not-started': { kind: 'not-started', reason: 'the program was not found' },
};

describe('tool install goldens', () => {
  for (const [name, world] of Object.entries(PLAN_WORLDS)) {
    it(`should plan the installs for ${name} exactly as the base does`, () => {
      expectGolden(`tool-install/plans-${name}`, built(world).plans(HARNESSES));
    });
  }

  for (const [name, result] of Object.entries(RUN_RESULTS)) {
    for (const found of [true, false]) {
      it(`should end an npm install that ${name} (found afterwards: ${found}) exactly as the base does`, async () => {
        const world: World = {
          platform: 'linux',
          onPath: { npm: '/usr/bin/npm' },
          result,
          ...(found ? { foundAfterRun: HARNESSES } : {}),
        };
        const { built: tool, runs } = service(world);
        const outcomes = await tool.install({ harnesses: HARNESSES }, OWNER);
        expectGolden(`tool-install/run-${name}-${found ? 'found' : 'missing'}`, { outcomes, runs });
      });
    }
  }
});

const built = (world: World) => service(world).built;
