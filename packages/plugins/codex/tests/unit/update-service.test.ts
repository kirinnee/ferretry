import { describe, it } from 'bun:test';
import should from 'should';
import type { HarnessCliView } from '../../contract/index.ts';
import {
  HARNESS_CHECK_REUSE_MS,
  HARNESS_PROBE_REUSE_MS,
  type HarnessInstalledVersion,
  type HarnessLocation,
  type HarnessStartupCheck,
  type HarnessUpdateReport,
  HarnessUpdateRefusal,
  HarnessUpdateService,
  type InstallFacts,
  type LatestReleaseAnswer,
  type PackageInstallResult,
  type PackageInstallRun,
} from '../../daemon/lib/index.ts';

const HOME = '/home/kirin';
const NPM_PREFIX = '/home/kirin/.nvm/versions/node/v22';
const NPM_CODEX = `${NPM_PREFIX}/bin/codex`;
const BREW_CODEX = '/opt/homebrew/bin/codex';
const T0 = Date.parse('2026-10-20T09:00:00.000Z');
const NPM_PACKAGE = '@openai/codex';
const RELEASE = (version: string) => ({ version, url: `https://github.com/openai/codex/releases/tag/rust-v${version}` });

const located = (path: string): HarnessLocation => ({
  outcome: 'located',
  path,
  rule: 'inherited environment',
  declaredBy: 'PATH',
});

/** Where each fake binary resolves, which is what decides its install method. */
const RESOLVED: Record<string, string> = {
  [NPM_CODEX]: `${NPM_PREFIX}/lib/node_modules/${NPM_PACKAGE}/bin/codex.js`,
  [BREW_CODEX]: '/opt/homebrew/Caskroom/codex/0.145.0/codex',
  '/etc/profiles/per-user/kirin/bin/codex': '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-codex/bin/codex',
  '/home/kirin/.nix-profile/bin/codex': '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-codex/bin/codex',
};

/** A machine: where Codex is, what the binary says, and what each package manager does. */
class World {
  now = T0;
  location: HarnessLocation = located(BREW_CODEX);
  versions = new Map<string, HarnessInstalledVersion>([
    [NPM_CODEX, { state: 'ok', version: '0.140.0' }],
    [BREW_CODEX, { state: 'ok', version: '0.140.0' }],
    ['/etc/profiles/per-user/kirin/bin/codex', { state: 'ok', version: '0.140.0' }],
    ['/home/kirin/.nix-profile/bin/codex', { state: 'ok', version: '0.140.0' }],
  ]);
  startups = new Map<string, HarnessStartupCheck>();
  latest: LatestReleaseAnswer = { kind: 'ok', release: RELEASE('0.145.0') };
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
      homeDirectory: async () => HOME,
      locate: async () => this.location,
      facts: {
        facts: async (launchedPath): Promise<InstallFacts> => ({
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
        latest: async () => {
          this.latestAsked += 1;
          return this.latest;
        },
      },
      executables: {
        resolve: async name => this.resolvable.get(name),
        runnable: async path => this.runnable.has(path),
      },
      run: async run => {
        this.runs.push(run);
        const next = this.script.shift();
        return next === undefined ? { kind: 'exited', code: 0, tail: [] } : await next(run);
      },
      nowMs: () => this.now,
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

const report = async (service: HarnessUpdateService): Promise<HarnessUpdateReport> => {
  await service.settled();
  const job = (await service.view()).job;
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

describe('the Codex update view', () => {
  it('says where Codex is, what it runs, how it was installed and what updating takes', async () => {
    const world = new World();
    world.location = located(NPM_CODEX);
    const view: HarnessCliView = await world.service().view();
    should(view).eql({
      harness: 'codex',
      location: { state: 'located', path: NPM_CODEX, rule: 'inherited environment', declaredBy: 'PATH' },
      installed: { state: 'ok', version: '0.140.0' },
      method: { kind: 'npm-global', tool: 'npm', package: NPM_PACKAGE, prefix: NPM_PREFIX, nodeManager: 'nvm' },
      plan: {
        kind: 'self',
        steps: [{ command: `npm install -g --prefix ${NPM_PREFIX} ${NPM_PACKAGE}@latest` }],
        rollback: 'automatic',
        pinsVersion: true,
      },
      check: { state: 'ok', checkedAt: '2026-10-20T09:00:00.000Z', latest: RELEASE('0.145.0') },
      verified: {
        version: '0.145.0',
        url: 'https://github.com/kirinnee/ferretry/blob/main/packages/fleet/tests/contract/README.md',
      },
      verification: 'older',
      available: true,
      job: null,
    });
  });

  it('reports a Homebrew cask, and Codex it cannot find or an override that names nothing runnable, with no method', async () => {
    const world = new World();
    should(await world.service().view()).containDeep({
      method: { kind: 'homebrew', type: 'cask', package: 'codex' },
      available: true,
    });
    world.location = { outcome: 'absent', searched: ['/opt/bin'] };
    const absent = await world.service().view();
    should(absent).containDeep({ location: { state: 'absent', searched: ['/opt/bin'] }, installed: null, method: null });
    should(absent.plan).be.null();
    should(absent.available).be.false();
    world.location = { outcome: 'override-absent', path: '/nope/codex', declaredBy: 'harness-codex.yaml', reason: 'it is not there' };
    should((await world.service().view()).location).eql({
      state: 'override-absent',
      path: '/nope/codex',
      declaredBy: 'harness-codex.yaml',
      reason: 'it is not there',
    });
  });

  it('asks npm only when somebody looks, and reuses the answer for a few minutes', async () => {
    const world = new World();
    const service = world.service();
    should(world.latestAsked).equal(0);
    await service.view();
    await service.view();
    should(world.latestAsked).equal(1);
    world.now += HARNESS_CHECK_REUSE_MS;
    await service.view();
    should(world.latestAsked).equal(2);
  });

  it('asks the binary its version again only after a short reuse', async () => {
    const world = new World();
    const service = world.service();
    await service.view();
    await service.view();
    should(world.probes).equal(1);
    world.now += HARNESS_PROBE_REUSE_MS;
    await service.view();
    should(world.probes).equal(2);
  });

  it('never asks npm when checks are off', async () => {
    const world = new World();
    world.checks = false;
    const view = await world.service().view();
    should(world.latestAsked).equal(0);
    should(view.check).eql({ state: 'never' });
    should(view.available).be.false();
  });

  it('keeps the last good answer beside a failed check, and carries it through another failure', async () => {
    const world = new World();
    const service = world.service();
    await service.view();
    world.latest = { kind: 'failed', reason: 'could not reach npm' };
    world.now += HARNESS_CHECK_REUSE_MS;
    const once = await service.view();
    should(once.check).eql({
      state: 'failed',
      checkedAt: new Date(world.now).toISOString(),
      reason: 'could not reach npm',
      lastKnown: { checkedAt: '2026-10-20T09:00:00.000Z', latest: RELEASE('0.145.0') },
    });
    should(once.available).be.true();
    world.now += HARNESS_CHECK_REUSE_MS;
    should((await service.view()).check).containDeep({ state: 'failed', lastKnown: { latest: { version: '0.145.0' } } });
  });

  it('reads an unreadable version as no version, and treats any known version as newer than it', async () => {
    const world = new World();
    world.versions.set(BREW_CODEX, { state: 'unreadable', reason: 'it timed out' });
    should(await world.service().view()).containDeep({
      installed: { state: 'unreadable' },
      verification: 'unknown',
      available: true,
    });
  });
});

describe('refusing to start', () => {
  it('refuses Codex this daemon cannot find', async () => {
    const world = new World();
    world.location = { outcome: 'absent', searched: [] };
    should(await refusal(world.service().start({}))).have.property('code', 'harness_update_not_located');
  });

  it('refuses a method Ferretry cannot update, which shows steps instead', async () => {
    const world = new World();
    world.location = located('/etc/profiles/per-user/kirin/bin/codex');
    should(await refusal(world.service().start({}))).have.property('code', 'harness_update_not_self_updatable');
  });

  it('refuses a chosen version for a method that installs what it has', async () => {
    const world = new World();
    const refused = await refusal(world.service().start({ target: '0.145.0' }));
    should(refused.code).equal('harness_update_not_targetable');
    should(refused.message).match(/Homebrew installs the newest Codex it has/u);
  });

  it('refuses an update to nothing newer', async () => {
    const world = new World();
    world.location = located(NPM_CODEX);
    world.versions.set(NPM_CODEX, { state: 'ok', version: '0.145.0' });
    const service = world.service();
    should((await refusal(service.start({}))).message).equal('Codex 0.145.0 is already the newest version known');
    should((await refusal(service.start({ target: '0.140.0' }))).message).equal(
      'Codex already runs 0.145.0, which is not older than 0.140.0',
    );
  });

  it('refuses to go past the verified version without an explicit yes, naming both', async () => {
    const world = new World();
    world.latest = { kind: 'ok', release: RELEASE('0.163.0') };
    const refused = await refusal(world.service().start({}));
    should(refused.code).equal('harness_update_unverified');
    should(refused.unverified).eql({ target: '0.163.0', verified: '0.145.0' });
    should(refused.message).match(/has not been verified by Ferretry yet/u);
  });

  it('treats a version nobody could learn as one that needs the same yes', async () => {
    const world = new World();
    world.checks = false;
    const refused = await refusal(world.service().start({}));
    should(refused.code).equal('harness_update_unverified');
    should(refused.unverified).eql({ verified: '0.145.0' });
  });

  it('refuses a second update while one runs', async () => {
    const world = new World();
    world.location = located(NPM_CODEX);
    let release: () => void = () => undefined;
    world.script = [
      () =>
        new Promise<PackageInstallResult>(resolve => (release = () => resolve({ kind: 'exited', code: 0, tail: [] }))),
    ];
    const service = world.service();
    await service.start({ target: '0.145.0' });
    should(await refusal(service.start({ target: '0.145.0' }))).have.property('code', 'harness_update_in_progress');
    release();
    await service.settled();
  });
});

describe('updating', () => {
  it('runs the prefix’s own npm to the target, checks it starts, and says running ferrets keep theirs', async () => {
    const world = new World();
    world.location = located(NPM_CODEX);
    world.script = [world.installs(NPM_CODEX, '0.145.0')];
    const service = world.service();
    await service.start({ target: '0.145.0' });
    const done = await report(service);
    should(world.runs.map(run => [run.executable, ...run.args])).eql([
      [`${NPM_PREFIX}/bin/npm`, 'install', '-g', '--prefix', NPM_PREFIX, `${NPM_PACKAGE}@0.145.0`],
    ]);
    should(done).containDeep({ from: '0.140.0', to: '0.145.0', target: '0.145.0', outcome: 'succeeded' });
    should(done.message).match(/Updated Codex 0\.140\.0 → 0\.145\.0\./u);
    should(done.message).match(/Running ferrets keep the version they started with/u);
  });

  it('accepts a newer version than the one offered, and says so', async () => {
    const world = new World();
    world.location = located(NPM_CODEX);
    world.script = [world.installs(NPM_CODEX, '0.150.0')];
    const service = world.service();
    await service.start({ target: '0.145.0' });
    should((await report(service)).message).match(/\(newer than the 0\.145\.0 you were offered\)/u);
  });

  it('refreshes Homebrew, upgrades the cask, and says when Homebrew is behind npm', async () => {
    const world = new World();
    world.latest = { kind: 'ok', release: RELEASE('0.163.0') };
    world.script = [() => ({ kind: 'exited', code: 0, tail: [] }), world.installs(BREW_CODEX, '0.150.0')];
    const service = world.service();
    await service.start({ confirmUnverified: true });
    const done = await report(service);
    should(world.runs.map(run => [run.executable, ...run.args])).eql([
      ['/opt/homebrew/bin/brew', 'update'],
      ['/opt/homebrew/bin/brew', 'upgrade', '--cask', 'codex'],
    ]);
    should(done).containDeep({ outcome: 'succeeded', to: '0.150.0' });
    should(done.message).match(/This install method does not have 0\.163\.0 yet\./u);
  });

  it('calls an update that changed nothing unchanged, never a success', async () => {
    const world = new World();
    world.latest = { kind: 'ok', release: RELEASE('0.163.0') };
    const service = world.service();
    await service.start({ confirmUnverified: true });
    should(await report(service)).containDeep({
      outcome: 'unchanged',
      message: 'Codex is still 0.140.0: this install method has nothing newer yet (npm has 0.163.0).',
    });
  });

  it('upgrades a nix profile element with the nix this daemon can find', async () => {
    const world = new World();
    world.location = located('/home/kirin/.nix-profile/bin/codex');
    world.runnable.add('/home/kirin/.nix-profile/bin/nix');
    world.script = [world.installs('/home/kirin/.nix-profile/bin/codex', '0.145.0')];
    const service = world.service();
    await service.start({});
    should(world.runs.map(run => [run.executable, ...run.args])).eql([
      ['/home/kirin/.nix-profile/bin/nix', 'profile', 'upgrade', '--refresh', 'codex'],
    ]);
    should(await report(service)).containDeep({ outcome: 'succeeded', to: '0.145.0' });
  });
});

describe('when an update goes wrong', () => {
  it('says a manager it cannot find, and the command to run instead', async () => {
    const world = new World();
    world.resolvable.delete('brew');
    const service = world.service();
    await service.start({ confirmUnverified: true });
    should(await report(service)).containDeep({
      outcome: 'failed',
      message:
        'The update did not finish: this daemon cannot find `brew` on its PATH; run `brew update` yourself. Codex still runs 0.140.0.',
    });
  });

  it('quotes a manager that failed, and says the old version still runs', async () => {
    const world = new World();
    world.location = located(NPM_CODEX);
    world.script = [() => ({ kind: 'exited', code: 1, tail: ['npm ERR! code E404'] })];
    const service = world.service();
    await service.start({ target: '0.145.0' });
    should((await report(service)).message).equal(
      `The update did not finish: \`npm install -g --prefix ${NPM_PREFIX} ${NPM_PACKAGE}@0.145.0\` stopped with exit code 1. It said: npm ERR! code E404 Codex still runs 0.140.0.`,
    );
  });

  it('never runs sudo: a manager that needs admin rights is handed back', async () => {
    const world = new World();
    world.location = located(NPM_CODEX);
    world.script = [() => ({ kind: 'exited', code: 243, tail: ['npm ERR! Error: EACCES: permission denied'] })];
    const service = world.service();
    await service.start({ target: '0.145.0' });
    should((await report(service)).message).match(
      /needs admin rights this daemon does not have, and Ferretry never runs sudo/u,
    );
  });

  it('says a manager that could not start, or did not finish in time', async () => {
    for (const [result, words] of [
      [{ kind: 'not-started', reason: 'ENOENT' }, /could not be started: ENOENT/u],
      [{ kind: 'timed-out', tail: [] }, /did not finish within 1 minutes\./u],
    ] as const) {
      const world = new World();
      world.location = located(NPM_CODEX);
      world.script = [() => result];
      const service = world.service(1);
      await service.start({ target: '0.145.0' });
      should((await report(service)).message).match(words);
    }
  });

  it('puts the previous version back when the new one does not start', async () => {
    const world = new World();
    world.location = located(NPM_CODEX);
    world.script = [
      run => {
        world.versions.set(NPM_CODEX, { state: 'ok', version: '0.145.0' });
        world.startups.set(NPM_CODEX, { ok: false, reason: '--help exited 1' });
        return { kind: 'exited', code: 0, tail: [run.args.join(' ')] };
      },
      () => {
        world.versions.set(NPM_CODEX, { state: 'ok', version: '0.140.0' });
        world.startups.delete(NPM_CODEX);
        return { kind: 'exited', code: 0, tail: [] };
      },
    ];
    const service = world.service();
    await service.start({ target: '0.145.0' });
    const done = await report(service);
    should(world.runs[1]?.args).eql(['install', '-g', '--prefix', NPM_PREFIX, `${NPM_PACKAGE}@0.140.0`]);
    should(done).eql({
      from: '0.140.0',
      to: '0.140.0',
      target: '0.145.0',
      outcome: 'rolled-back',
      message: 'After the update it did not start (--help exited 1). 0.140.0 was put back, and it starts.',
      finishedAt: '2026-10-20T09:00:00.000Z',
    });
  });

  it('rolls back a pinned install that came up older than asked', async () => {
    const world = new World();
    world.location = located(NPM_CODEX);
    world.script = [world.installs(NPM_CODEX, '0.141.0'), world.installs(NPM_CODEX, '0.140.0')];
    const service = world.service();
    await service.start({ target: '0.145.0' });
    should(await report(service)).containDeep({
      outcome: 'rolled-back',
      message: 'After the update it runs 0.141.0, older than the 0.145.0 asked for. 0.140.0 was put back, and it starts.',
    });
  });

  it('says so when putting the previous version back fails too, with the commands to run', async () => {
    const world = new World();
    world.location = located(NPM_CODEX);
    world.script = [
      () => {
        world.startups.set(NPM_CODEX, { ok: false, reason: 'boom' });
        return { kind: 'exited', code: 0, tail: [] };
      },
      () => ({ kind: 'exited', code: 1, tail: ['npm ERR! network'] }),
    ];
    const service = world.service();
    await service.start({ target: '0.145.0' });
    const done = await report(service);
    should(done.outcome).equal('failed');
    should(done.message).match(/Putting 0\.140\.0 back did not work either/u);
    should(done.message).match(new RegExp(`run \`npm install -g --prefix ${NPM_PREFIX} ${NPM_PACKAGE}@0.140.0\` yourself`, 'u'));
  });

  it('says Homebrew keeps no previous version, so a broken upgrade cannot be put back', async () => {
    const world = new World();
    world.latest = { kind: 'ok', release: RELEASE('0.163.0') };
    world.script = [
      () => ({ kind: 'exited', code: 0, tail: [] }),
      () => {
        world.versions.set(BREW_CODEX, { state: 'ok', version: '0.150.0' });
        world.startups.set(BREW_CODEX, { ok: false, reason: 'broken' });
        return { kind: 'exited', code: 0, tail: [] };
      },
    ];
    const service = world.service();
    await service.start({ confirmUnverified: true });
    const done = await report(service);
    should(done.outcome).equal('failed');
    should(done.message).match(/keeps no previous version/u);
  });

  it('turns an unexpected throw into a failed report rather than a lost job', async () => {
    const world = new World();
    world.location = located(NPM_CODEX);
    world.script = [
      () => {
        throw new Error('odd');
      },
    ];
    const service = world.service();
    await service.start({ target: '0.145.0' });
    should((await report(service)).message).equal('The update stopped: odd.');
  });

  it('shows the last reading while an update runs, without asking the binary or npm again', async () => {
    const world = new World();
    world.location = located(NPM_CODEX);
    world.checks = false;
    let release: () => void = () => undefined;
    world.script = [
      () =>
        new Promise<PackageInstallResult>(resolve => (release = () => resolve({ kind: 'exited', code: 0, tail: [] }))),
    ];
    const service = world.service();
    await service.start({ target: '0.145.0' });
    const probes = world.probes;
    world.now += HARNESS_PROBE_REUSE_MS * 10;
    const during = await service.view();
    should(during.job?.state).equal('running');
    should(during.check).eql({ state: 'never' });
    should(world.probes).equal(probes);
    release();
    await service.settled();
  });
});
