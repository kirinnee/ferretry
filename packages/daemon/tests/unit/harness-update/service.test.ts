import { describe, it } from 'bun:test';
import type {
  Harness,
  HarnessCliView,
  HarnessInstalledVersion,
  HarnessInstallFacts,
  HarnessUpdateReport,
} from '@ferretry/protocol';
import should from 'should';
import type { HarnessLocation } from '../../../src/lib/core/harness-readiness.ts';
import type { PackageInstallResult, PackageInstallRun } from '../../../src/lib/fleet/tool-install.ts';
import {
  HARNESS_CHECK_REUSE_MS,
  HARNESS_PROBE_REUSE_MS,
  type HarnessStartupCheck,
  HarnessUpdateRefusal,
  HarnessUpdateService,
} from '../../../src/lib/harness-update/index.ts';
import type { LatestReleaseAnswer } from '../../../src/lib/update/ports.ts';

const HOME = '/home/kirin';
const NPM_PREFIX = '/home/kirin/.nvm/versions/node/v22';
const CLAUDE = `${NPM_PREFIX}/bin/claude`;
const CODEX = '/opt/homebrew/bin/codex';
const T0 = Date.parse('2026-10-20T09:00:00.000Z');
const CHANGELOG = 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md';

const located = (kind: Harness, path: string): HarnessLocation => ({
  kind,
  outcome: 'located',
  path,
  rule: 'inherited environment',
  declaredBy: 'PATH',
});

/** Where each fake binary resolves, which is what decides its install method. */
const RESOLVED: Record<string, string> = {
  [CLAUDE]: `${NPM_PREFIX}/lib/node_modules/@anthropic-ai/claude-code/cli.js`,
  [CODEX]: '/opt/homebrew/Caskroom/codex/0.145.0/codex',
  '/home/kirin/.local/bin/claude': `${HOME}/.local/share/claude/versions/2.1.200`,
  '/etc/profiles/per-user/kirin/bin/claude': '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-claude-code/bin/claude',
  '/home/kirin/.nix-profile/bin/codex': '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-codex/bin/codex',
  '/usr/local/bin/codex': '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
  '/home/kirin/.bun/bin/claude': `${HOME}/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js`,
  '/home/kirin/.local/share/pnpm/claude': `${HOME}/.local/share/pnpm/global/5/node_modules/@anthropic-ai/claude-code/cli.js`,
  '/home/kirin/.volta/bin/claude': `${HOME}/.volta/bin/volta-shim`,
  '/plain/npm/codex': '/plain/npm/node_modules/@openai/codex/bin/codex.js',
};

/** A machine: where each harness is, what each binary says, and what each package manager does. */
class World {
  now = T0;
  locations: Record<Harness, HarnessLocation> = {
    claude: located('claude', CLAUDE),
    codex: located('codex', CODEX),
  };
  versions = new Map<string, HarnessInstalledVersion>([
    [CLAUDE, { state: 'ok', version: '2.1.200' }],
    [CODEX, { state: 'ok', version: '0.140.0' }],
  ]);
  startups = new Map<string, HarnessStartupCheck>();
  latest: Record<Harness, LatestReleaseAnswer> = {
    claude: { kind: 'ok', release: { version: '2.1.230', url: CHANGELOG } },
    codex: {
      kind: 'ok',
      release: { version: '0.145.0', url: 'https://github.com/openai/codex/releases/tag/rust-v0.145.0' },
    },
  };
  latestAsked = 0;
  probes = 0;
  resolvable = new Map<string, string>([
    ['brew', '/opt/homebrew/bin/brew'],
    ['npm', '/usr/bin/npm'],
  ]);
  runnable = new Set<string>([`${NPM_PREFIX}/bin/npm`]);
  runs: PackageInstallRun[] = [];
  /** What each run does, in order; the default exits 0. */
  script: ((run: PackageInstallRun) => PackageInstallResult | Promise<PackageInstallResult>)[] = [];
  checks = true;

  service(timeoutMinutes?: number): HarnessUpdateService {
    return new HarnessUpdateService({
      product: 'ferretry',
      homeDirectory: HOME,
      locate: harness => this.locations[harness],
      facts: {
        facts: async (harness, launchedPath): Promise<HarnessInstallFacts> => ({
          harness,
          launchedPath,
          resolvedPath: RESOLVED[launchedPath] ?? launchedPath,
          homeDirectory: HOME,
          platform: 'linux',
          viaHomeManagerPath: launchedPath.startsWith('/etc/profiles/'),
          ...(launchedPath === '/home/kirin/.nix-profile/bin/codex' ? { nixProfileElement: 'codex' } : {}),
        }),
      },
      probe: {
        version: async path => {
          this.probes += 1;
          return this.versions.get(path) ?? { state: 'unreadable', reason: 'no such fake' };
        },
        startup: async path => this.startups.get(path) ?? { ok: true },
      },
      latest: {
        latest: async harness => {
          this.latestAsked += 1;
          return this.latest[harness];
        },
      },
      executables: {
        resolve: name => this.resolvable.get(name),
        runnable: path => this.runnable.has(path),
      },
      run: async run => {
        this.runs.push(run);
        const next = this.script.shift();
        return next === undefined ? { kind: 'exited', code: 0, tail: [] } : await next(run);
      },
      environment: { PATH: '/usr/bin', HOME },
      clock: { now: () => this.now },
      checks: this.checks,
      ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
    });
  }

  /** A run that installs `version` at `path`, as a package manager would. */
  installs(path: string, version: string): (run: PackageInstallRun) => PackageInstallResult {
    return () => {
      this.versions.set(path, { state: 'ok', version });
      return { kind: 'exited', code: 0, tail: ['added 1 package'] };
    };
  }
}

const harnessView = async (service: HarnessUpdateService, harness: Harness): Promise<HarnessCliView> => {
  const view = await service.view();
  const found = view.harnesses.find(entry => entry.harness === harness);
  if (found === undefined) throw new Error(`no ${harness} in the view`);
  return found;
};

const report = async (service: HarnessUpdateService, harness: Harness): Promise<HarnessUpdateReport> => {
  await service.settled();
  const job = (await harnessView(service, harness)).job;
  if (job?.state !== 'finished') throw new Error(`no finished job: ${JSON.stringify(job)}`);
  return job.report;
};

const refusal = async (promise: Promise<unknown>): Promise<HarnessUpdateRefusal> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HarnessUpdateRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('the harness update view', () => {
  it('says where each harness is, what it runs, how it was installed and what updating takes', async () => {
    const world = new World();
    const view = await world.service().view();
    should(view.harnesses.map(entry => entry.harness)).eql(['claude', 'codex']);
    const [claude, codex] = view.harnesses;
    should(claude).eql({
      harness: 'claude',
      location: { state: 'located', path: CLAUDE, rule: 'inherited environment', declaredBy: 'PATH' },
      installed: { state: 'ok', version: '2.1.200' },
      method: {
        kind: 'npm-global',
        tool: 'npm',
        package: '@anthropic-ai/claude-code',
        prefix: NPM_PREFIX,
        nodeManager: 'nvm',
      },
      plan: {
        kind: 'self',
        steps: [{ command: `npm install -g --prefix ${NPM_PREFIX} @anthropic-ai/claude-code@latest` }],
        rollback: 'automatic',
        pinsVersion: true,
      },
      check: { state: 'ok', checkedAt: '2026-10-20T09:00:00.000Z', latest: { version: '2.1.230', url: CHANGELOG } },
      verified: {
        version: '2.1.220',
        url: 'https://github.com/kirinnee/ferretry/blob/main/packages/fleet/tests/contract/README.md',
      },
      verification: 'older',
      available: true,
      job: null,
    });
    should(codex).containDeep({ method: { kind: 'homebrew', type: 'cask', package: 'codex' }, available: true });
  });

  it('reports a harness it cannot find, and an override that names nothing runnable, with no method', async () => {
    const world = new World();
    world.locations.claude = { kind: 'claude', outcome: 'absent', searched: ['/opt/bin'] };
    world.locations.codex = {
      kind: 'codex',
      outcome: 'override-absent',
      path: '/nope/codex',
      declaredBy: 'FY_CODEX_BIN',
      reason: 'it is not there',
    };
    const [claude, codex] = (await world.service().view()).harnesses;
    should(claude).containDeep({
      location: { state: 'absent', searched: ['/opt/bin'] },
      installed: null,
      method: null,
    });
    should(claude?.plan).be.null();
    should(claude?.available).be.false();
    should(codex?.location).eql({
      state: 'override-absent',
      path: '/nope/codex',
      declaredBy: 'FY_CODEX_BIN',
      reason: 'it is not there',
    });
  });

  it('asks npm only when somebody looks, and reuses the answer for a few minutes', async () => {
    const world = new World();
    const service = world.service();
    should(world.latestAsked).equal(0);
    await service.view();
    await service.view();
    should(world.latestAsked).equal(2);
    world.now += HARNESS_CHECK_REUSE_MS;
    await service.view();
    should(world.latestAsked).equal(4);
  });

  it('asks the binary its version again only after a short reuse', async () => {
    const world = new World();
    const service = world.service();
    await service.view();
    await service.view();
    should(world.probes).equal(2);
    world.now += HARNESS_PROBE_REUSE_MS;
    await service.view();
    should(world.probes).equal(4);
  });

  it('never asks npm when checks are off', async () => {
    const world = new World();
    world.checks = false;
    const claude = await harnessView(world.service(), 'claude');
    should(world.latestAsked).equal(0);
    should(claude.check).eql({ state: 'never' });
    should(claude.available).be.false();
  });

  it('keeps the last good answer beside a failed check, and carries it through another failure', async () => {
    const world = new World();
    const service = world.service();
    await service.view();
    world.latest.claude = { kind: 'failed', reason: 'could not reach npm' };
    world.now += HARNESS_CHECK_REUSE_MS;
    const once = await harnessView(service, 'claude');
    should(once.check).eql({
      state: 'failed',
      checkedAt: new Date(world.now).toISOString(),
      reason: 'could not reach npm',
      lastKnown: { checkedAt: '2026-10-20T09:00:00.000Z', latest: { version: '2.1.230', url: CHANGELOG } },
    });
    should(once.available).be.true();
    world.now += HARNESS_CHECK_REUSE_MS;
    const twice = await harnessView(service, 'claude');
    should(twice.check).containDeep({ state: 'failed', lastKnown: { latest: { version: '2.1.230' } } });
  });

  it('says a failure with nothing known before it plainly', async () => {
    const world = new World();
    world.latest.claude = { kind: 'failed', reason: 'npm answered 503' };
    const claude = await harnessView(world.service(), 'claude');
    should(claude.check).eql({ state: 'failed', checkedAt: '2026-10-20T09:00:00.000Z', reason: 'npm answered 503' });
  });

  it('reads an unreadable version as no version, and treats any known version as newer than it', async () => {
    const world = new World();
    world.versions.set(CLAUDE, { state: 'unreadable', reason: 'it timed out' });
    const claude = await harnessView(world.service(), 'claude');
    should(claude).containDeep({ installed: { state: 'unreadable' }, verification: 'unknown', available: true });
  });
});

describe('refusing to start', () => {
  it('refuses a harness this daemon cannot find', async () => {
    const world = new World();
    world.locations.claude = { kind: 'claude', outcome: 'absent', searched: [] };
    should(await refusal(world.service().start({ harness: 'claude' }))).have.property(
      'code',
      'harness_update_not_located',
    );
  });

  it('refuses a method Ferretry cannot update, which shows steps instead', async () => {
    const world = new World();
    world.locations.claude = located('claude', '/etc/profiles/per-user/kirin/bin/claude');
    world.versions.set('/etc/profiles/per-user/kirin/bin/claude', { state: 'ok', version: '2.1.200' });
    should(await refusal(world.service().start({ harness: 'claude' }))).have.property(
      'code',
      'harness_update_not_self_updatable',
    );
  });

  it('refuses a chosen version for a method that installs what it has', async () => {
    const world = new World();
    const refused = await refusal(world.service().start({ harness: 'codex', target: '0.145.0' }));
    should(refused.code).equal('harness_update_not_targetable');
    should(refused.message).match(/Homebrew installs the newest Codex it has/u);
  });

  it('refuses an update to nothing newer', async () => {
    const world = new World();
    world.versions.set(CLAUDE, { state: 'ok', version: '2.1.230' });
    const service = world.service();
    should((await refusal(service.start({ harness: 'claude' }))).message).equal(
      'Claude Code 2.1.230 is already the newest version known',
    );
    should((await refusal(service.start({ harness: 'claude', target: '2.1.220' }))).message).equal(
      'Claude Code already runs 2.1.230, which is not older than 2.1.220',
    );
  });

  it('refuses to go past the verified version without an explicit yes, naming both', async () => {
    const world = new World();
    const refused = await refusal(world.service().start({ harness: 'claude' }));
    should(refused.code).equal('harness_update_unverified');
    should(refused.unverified).eql({ target: '2.1.230', verified: '2.1.220' });
    should(refused.message).match(/has not been verified by Ferretry yet/u);
    should(world.runs).be.empty();
  });

  it('treats a version nobody could learn as one that needs the same yes', async () => {
    const world = new World();
    world.checks = false;
    const refused = await refusal(world.service().start({ harness: 'codex' }));
    should(refused.unverified).eql({ verified: '0.145.0' });
    should(refused.message).match(/could not learn which Codex version/u);
  });

  it('refuses a second update of the same harness while one runs', async () => {
    const world = new World();
    let release: () => void = () => undefined;
    world.script = [
      () =>
        new Promise<PackageInstallResult>(resolve => (release = () => resolve({ kind: 'exited', code: 0, tail: [] }))),
    ];
    const service = world.service();
    await service.start({ harness: 'claude', target: '2.1.220' });
    should(await refusal(service.start({ harness: 'claude', target: '2.1.220' }))).have.property(
      'code',
      'harness_update_in_progress',
    );
    release();
    await service.settled();
  });
});

describe('updating', () => {
  it('runs the prefix’s own npm to the verified version, checks it starts, and says running ferrets keep theirs', async () => {
    const world = new World();
    world.script = [world.installs(CLAUDE, '2.1.220')];
    const service = world.service();
    const started = await service.start({ harness: 'claude', target: '2.1.220' });
    should(started.harnesses[0]?.job).containDeep({
      state: 'running',
      target: '2.1.220',
      command: `npm install -g --prefix ${NPM_PREFIX} @anthropic-ai/claude-code@2.1.220`,
    });
    const done = await report(service, 'claude');
    should(world.runs.map(run => [run.executable, ...run.args])).eql([
      [`${NPM_PREFIX}/bin/npm`, 'install', '-g', '--prefix', NPM_PREFIX, '@anthropic-ai/claude-code@2.1.220'],
    ]);
    should(world.runs[0]?.environment.PATH).equal(`${NPM_PREFIX}/bin:/usr/bin`);
    should(world.runs[0]?.timeoutMs).equal(15 * 60_000);
    should(done).eql({
      from: '2.1.200',
      to: '2.1.220',
      target: '2.1.220',
      outcome: 'succeeded',
      message:
        'Updated Claude Code 2.1.200 → 2.1.220. Running ferrets keep the version they started with until they are restarted; new ones start on this one.',
      finishedAt: '2026-10-20T09:00:00.000Z',
    });
    should((await harnessView(service, 'claude')).installed).eql({ state: 'ok', version: '2.1.220' });
  });

  it('accepts a newer version than the one offered, and says so', async () => {
    const world = new World();
    world.script = [world.installs(CLAUDE, '2.1.231')];
    const service = world.service();
    await service.start({ harness: 'claude', confirmUnverified: true });
    should((await report(service, 'claude')).message).match(
      /2\.1\.200 → 2\.1\.231 \(newer than the 2\.1\.230 you were offered\)/u,
    );
  });

  it('refreshes Homebrew, upgrades the cask, and says when Homebrew is behind npm', async () => {
    const world = new World();
    world.latest.codex = { kind: 'ok', release: { version: '0.163.0', url: 'https://example.test/c' } };
    world.script = [() => ({ kind: 'exited', code: 0, tail: [] }), world.installs(CODEX, '0.150.0')];
    const service = world.service();
    await service.start({ harness: 'codex', confirmUnverified: true });
    const done = await report(service, 'codex');
    should(world.runs.map(run => [run.executable, ...run.args])).eql([
      ['/opt/homebrew/bin/brew', 'update'],
      ['/opt/homebrew/bin/brew', 'upgrade', '--cask', 'codex'],
    ]);
    should(done).containDeep({ outcome: 'succeeded', to: '0.150.0' });
    should(done.message).match(/This install method does not have 0\.163\.0 yet\./u);
  });

  it('calls an update that changed nothing unchanged, never a success', async () => {
    const world = new World();
    world.latest.codex = { kind: 'ok', release: { version: '0.163.0', url: 'https://example.test/c' } };
    const service = world.service();
    await service.start({ harness: 'codex', confirmUnverified: true });
    should(await report(service, 'codex')).containDeep({
      outcome: 'unchanged',
      message: 'Codex is still 0.140.0: this install method has nothing newer yet (npm has 0.163.0).',
    });
  });

  it('says an unchanged result without a known newest plainly', async () => {
    const world = new World();
    world.checks = false;
    const service = world.service();
    await service.start({ harness: 'codex', confirmUnverified: true });
    should((await report(service, 'codex')).message).equal(
      'Codex is still 0.140.0: this install method has nothing newer yet.',
    );
  });

  it('updates Claude Code’s own installer with `claude update`, and a chosen version with `claude install`', async () => {
    const world = new World();
    const native = '/home/kirin/.local/bin/claude';
    world.locations.claude = located('claude', native);
    world.versions.set(native, { state: 'ok', version: '2.1.200' });
    world.script = [world.installs(native, '2.1.220')];
    const service = world.service();
    await service.start({ harness: 'claude', target: '2.1.220' });
    await report(service, 'claude');
    should(world.runs.map(run => [run.executable, ...run.args])).eql([[native, 'install', '2.1.220']]);
  });

  it('upgrades a nix profile element with the nix this daemon can find', async () => {
    const world = new World();
    const profile = '/home/kirin/.nix-profile/bin/codex';
    world.locations.codex = located('codex', profile);
    world.versions.set(profile, { state: 'ok', version: '0.140.0' });
    world.runnable.add('/nix/var/nix/profiles/default/bin/nix');
    world.script = [world.installs(profile, '0.145.0')];
    const service = world.service();
    await service.start({ harness: 'codex' });
    should(await report(service, 'codex')).containDeep({ outcome: 'succeeded', to: '0.145.0' });
    should(world.runs[0]?.executable).equal('/nix/var/nix/profiles/default/bin/nix');
    should(world.runs[0]?.args).eql(['profile', 'upgrade', '--refresh', 'codex']);
  });

  it('finds bun, pnpm, volta and a plain npm where they usually live', async () => {
    const cases: readonly [string, Harness, string, string][] = [
      ['/home/kirin/.bun/bin/claude', 'claude', '/home/kirin/.bun/bin/bun', 'add'],
      ['/home/kirin/.local/share/pnpm/claude', 'claude', '/home/kirin/.local/share/pnpm/pnpm', 'add'],
      ['/home/kirin/.volta/bin/claude', 'claude', '/home/kirin/.volta/bin/volta', 'install'],
      ['/usr/local/bin/codex', 'codex', '/usr/bin/npm', 'install'],
      ['/plain/npm/codex', 'codex', '/usr/bin/npm', 'install'],
    ];
    for (const [path, harness, executable, verb] of cases) {
      const world = new World();
      world.locations[harness] = located(harness, path);
      world.versions.set(path, { state: 'ok', version: harness === 'claude' ? '2.1.200' : '0.140.0' });
      world.runnable.add(executable);
      const target = harness === 'claude' ? '2.1.220' : '0.145.0';
      world.script = [world.installs(path, target)];
      const service = world.service();
      await service.start({ harness, target });
      should(await report(service, harness)).containDeep({ outcome: 'succeeded' });
      should([world.runs[0]?.executable, world.runs[0]?.args[0]]).eql([executable, verb]);
    }
  });
});

describe('when an update goes wrong', () => {
  it('says a manager it cannot find, and the command to run instead', async () => {
    const world = new World();
    world.resolvable.delete('brew');
    const service = world.service();
    await service.start({ harness: 'codex' });
    should(await report(service, 'codex')).containDeep({
      outcome: 'failed',
      message:
        'The update did not finish: this daemon cannot find `brew` on its PATH; run `brew update` yourself. Codex still runs 0.140.0.',
    });
  });

  it('quotes a manager that failed, and says the old version still runs', async () => {
    const world = new World();
    world.script = [() => ({ kind: 'exited', code: 1, tail: ['npm ERR! code E404'] })];
    const service = world.service();
    await service.start({ harness: 'claude', target: '2.1.220' });
    should((await report(service, 'claude')).message).equal(
      `The update did not finish: \`npm install -g --prefix ${NPM_PREFIX} @anthropic-ai/claude-code@2.1.220\` stopped with exit code 1. It said: npm ERR! code E404 Claude Code still runs 2.1.200.`,
    );
  });

  it('never runs sudo: a manager that needs admin rights is handed back', async () => {
    const world = new World();
    world.script = [() => ({ kind: 'exited', code: 243, tail: ['npm ERR! Error: EACCES: permission denied'] })];
    const service = world.service();
    await service.start({ harness: 'claude', target: '2.1.220' });
    should((await report(service, 'claude')).message).match(
      /needs admin rights this daemon does not have, and Ferretry never runs sudo/u,
    );
  });

  it('says a manager that could not start, or did not finish in time', async () => {
    for (const [result, words] of [
      [{ kind: 'not-started', reason: 'ENOENT' }, /could not be started: ENOENT/u],
      [{ kind: 'timed-out', tail: [] }, /did not finish within 1 minutes\./u],
    ] as const) {
      const world = new World();
      world.script = [() => result];
      const service = world.service(1);
      await service.start({ harness: 'claude', target: '2.1.220' });
      should((await report(service, 'claude')).message).match(words);
    }
  });

  it('puts the previous version back when the new one does not start', async () => {
    const world = new World();
    world.script = [
      run => {
        world.versions.set(CLAUDE, { state: 'ok', version: '2.1.220' });
        world.startups.set(CLAUDE, { ok: false, reason: '--help exited 1' });
        return { kind: 'exited', code: 0, tail: [run.args.join(' ')] };
      },
      () => {
        world.versions.set(CLAUDE, { state: 'ok', version: '2.1.200' });
        world.startups.delete(CLAUDE);
        return { kind: 'exited', code: 0, tail: [] };
      },
    ];
    const service = world.service();
    await service.start({ harness: 'claude', target: '2.1.220' });
    const done = await report(service, 'claude');
    should(world.runs[1]?.args).eql(['install', '-g', '--prefix', NPM_PREFIX, '@anthropic-ai/claude-code@2.1.200']);
    should(done).eql({
      from: '2.1.200',
      to: '2.1.200',
      target: '2.1.220',
      outcome: 'rolled-back',
      message: 'After the update it did not start (--help exited 1). 2.1.200 was put back, and it starts.',
      finishedAt: '2026-10-20T09:00:00.000Z',
    });
  });

  it('rolls back a pinned install that came up older than asked, and one whose version is unreadable', async () => {
    const world = new World();
    world.script = [world.installs(CLAUDE, '2.1.210'), world.installs(CLAUDE, '2.1.200')];
    const service = world.service();
    await service.start({ harness: 'claude', target: '2.1.220' });
    should(await report(service, 'claude')).containDeep({
      outcome: 'rolled-back',
      message:
        'After the update it runs 2.1.210, older than the 2.1.220 asked for. 2.1.200 was put back, and it starts.',
    });
    const broken = new World();
    broken.script = [
      () => {
        broken.versions.set(CLAUDE, { state: 'unreadable', reason: 'it exited 1 without printing a version' });
        return { kind: 'exited', code: 0, tail: [] };
      },
      broken.installs(CLAUDE, '2.1.200'),
    ];
    const again = broken.service();
    await again.start({ harness: 'claude', target: '2.1.220' });
    should((await report(again, 'claude')).message).match(/^After the update its --version did not answer/u);
  });

  it('says so when putting the previous version back fails too, with the commands to run', async () => {
    const world = new World();
    world.script = [
      () => {
        world.startups.set(CLAUDE, { ok: false, reason: '--help exited 1' });
        world.versions.set(CLAUDE, { state: 'ok', version: '2.1.220' });
        return { kind: 'exited', code: 0, tail: [] };
      },
      () => ({ kind: 'exited', code: 1, tail: [] }),
    ];
    const service = world.service();
    await service.start({ harness: 'claude', target: '2.1.220' });
    should((await report(service, 'claude')).message).equal(
      `After the update it did not start (--help exited 1). Putting 2.1.200 back did not work either (\`npm install -g --prefix ${NPM_PREFIX} @anthropic-ai/claude-code@2.1.200\` stopped with exit code 1); run \`npm install -g --prefix ${NPM_PREFIX} @anthropic-ai/claude-code@2.1.200\` yourself.`,
    );
  });

  it('says a rollback that ran but left the wrong version', async () => {
    const world = new World();
    world.script = [
      () => {
        world.startups.set(CLAUDE, { ok: false, reason: 'boom' });
        return { kind: 'exited', code: 0, tail: [] };
      },
    ];
    const service = world.service();
    await service.start({ harness: 'claude', target: '2.1.220' });
    should((await report(service, 'claude')).message).match(/Putting 2\.1\.200 back did not work either; run/u);
  });

  it('says Homebrew keeps no previous version, so a broken upgrade cannot be put back', async () => {
    const world = new World();
    world.script = [
      () => ({ kind: 'exited', code: 0, tail: [] }),
      () => {
        world.versions.set(CODEX, { state: 'unreadable', reason: 'it crashed' });
        return { kind: 'exited', code: 0, tail: [] };
      },
    ];
    const service = world.service();
    await service.start({ harness: 'codex' });
    should((await report(service, 'codex')).message).equal(
      'After the update its --version did not answer (it crashed). This install method keeps no previous version, so Ferretry could not put it back; reinstall Codex with the steps for how it was installed.',
    );
  });

  it('cannot put back a version it never knew', async () => {
    const world = new World();
    world.versions.set(CLAUDE, { state: 'unreadable', reason: 'odd' });
    world.script = [
      () => {
        world.locations.claude = { kind: 'claude', outcome: 'absent', searched: [] };
        return { kind: 'exited', code: 1, tail: [] };
      },
    ];
    const service = world.service();
    await service.start({ harness: 'claude', target: '2.1.220' });
    const done = await report(service, 'claude');
    should(done).not.have.property('from');
    should(done.message).match(
      /^`npm install .*` stopped with exit code 1\. After the update this daemon can no longer find Claude Code\. Ferretry did not know which version ran before/u,
    );
  });

  it('turns an unexpected throw into a failed report rather than a lost job', async () => {
    const world = new World();
    world.script = [
      () => {
        throw new Error('disk full');
      },
    ];
    const service = world.service();
    await service.start({ harness: 'claude', target: '2.1.220' });
    should((await report(service, 'claude')).message).equal('The update stopped: disk full.');
    world.script = [
      () => {
        throw 'odd';
      },
    ];
    await service.start({ harness: 'claude', target: '2.1.220' });
    should((await report(service, 'claude')).message).equal('The update stopped: odd.');
  });

  it('shows the last reading while an update runs, without asking the binary or npm again', async () => {
    const world = new World();
    world.locations.codex = { kind: 'codex', outcome: 'absent', searched: [] };
    world.checks = false;
    let release: () => void = () => undefined;
    world.script = [
      () =>
        new Promise<PackageInstallResult>(resolve => (release = () => resolve({ kind: 'exited', code: 0, tail: [] }))),
    ];
    const service = world.service();
    await service.start({ harness: 'claude', target: '2.1.220' });
    const probes = world.probes;
    world.now += HARNESS_PROBE_REUSE_MS * 10;
    const during = await harnessView(service, 'claude');
    should(during.job?.state).equal('running');
    should(during.check).eql({ state: 'never' });
    should(world.probes).equal(probes);
    release();
    await service.settled();
  });
});
