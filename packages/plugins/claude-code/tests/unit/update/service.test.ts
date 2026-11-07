import { describe, it } from 'bun:test';
import should from 'should';
import { HARNESS_UPDATE_CODES, type HarnessCliView } from '../../../contract/index.ts';
import {
  HARNESS_CHECK_REUSE_MS,
  HarnessUpdateRefusal,
  HarnessUpdateService,
} from '../../../daemon/lib/update/service.ts';
import type {
  ClaudeLocation,
  RunRequest,
  RunResult,
  StartupCheck,
} from '../../../daemon/lib/update/ports.ts';
import type { HarnessInstalledVersion } from '../../../daemon/lib/update/recipes.ts';

const HOME = '/home/kirin';
const PREFIX = `${HOME}/.nvm/versions/node/v22`;
const CLAUDE = `${PREFIX}/bin/claude`;
const T0 = Date.parse('2026-10-20T09:00:00.000Z');
const CHANGELOG = 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md';

/** A machine: where claude is, what the binary says, and what each package manager does. */
class World {
  now = T0;
  location: ClaudeLocation = { outcome: 'located', path: CLAUDE, rule: 'inherited environment', declaredBy: 'PATH' };
  resolved = `${PREFIX}/lib/node_modules/@anthropic-ai/claude-code/cli.js`;
  version: HarnessInstalledVersion = { state: 'ok', version: '2.1.200' };
  startup: StartupCheck = { ok: true };
  latest = { kind: 'ok', release: { version: '2.1.230', url: CHANGELOG } } as const;
  latestAsked = 0;
  runs: RunRequest[] = [];
  script: ((run: RunRequest) => RunResult)[] = [];
  checks = true;

  service(): HarnessUpdateService {
    return new HarnessUpdateService({
      product: 'ferretry',
      location: { locate: async () => this.location },
      facts: {
        facts: async launchedPath => ({
          launchedPath,
          resolvedPath: this.resolved,
          homeDirectory: HOME,
          platform: 'linux',
        }),
      },
      probe: { version: async () => this.version, startup: async () => this.startup },
      latest: {
        latest: async () => {
          this.latestAsked += 1;
          return this.latest;
        },
      },
      run: async run => {
        this.runs.push(run);
        const next = this.script.shift();
        return next === undefined ? { kind: 'exited', code: 0, tail: [] } : next(run);
      },
      clock: { now: () => this.now },
      checks: this.checks,
    });
  }

  /** A run that installs `version`, as a package manager would. */
  installs(version: string): (run: RunRequest) => RunResult {
    return () => {
      this.version = { state: 'ok', version };
      return { kind: 'exited', code: 0, tail: ['added 1 package'] };
    };
  }
}

const refusalOf = async (promise: Promise<unknown>): Promise<HarnessUpdateRefusal> => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  should(error).be.instanceOf(HarnessUpdateRefusal);
  return error as HarnessUpdateRefusal;
};

const finished = async (service: HarnessUpdateService): Promise<HarnessCliView> => {
  await service.settled();
  return await service.view();
};

describe('HarnessUpdateService.view', () => {
  it('shows where claude is, how it was installed, what is newer, and what updating takes', async () => {
    const world = new World();

    const view = await world.service().view();

    should(view.harness).equal('claude-code');
    should(view.location).containEql({ state: 'located', path: CLAUDE });
    should(view.installed).eql({ state: 'ok', version: '2.1.200' });
    should(view.method).containEql({ kind: 'npm-global', tool: 'npm', prefix: PREFIX });
    should(view.plan).containEql({ kind: 'self', pinsVersion: true });
    should(view.available).be.true();
    should(view.verification).equal('older');
    should(view.job).be.null();
  });

  it('asks npm once within the reuse window, and again after it', async () => {
    const world = new World();
    const service = world.service();

    await service.view();
    await service.view();
    world.now += HARNESS_CHECK_REUSE_MS + 1;
    await service.view();

    should(world.latestAsked).equal(2);
  });

  it('never asks npm when checks are off', async () => {
    const world = new World();
    world.checks = false;

    const view = await world.service().view();

    should(world.latestAsked).equal(0);
    should(view.check).eql({ state: 'never' });
    should(view.available).be.false();
  });

  it('keeps the last good answer when a later check fails', async () => {
    const world = new World();
    const service = world.service();
    await service.view();
    world.now += HARNESS_CHECK_REUSE_MS + 1;
    (world as { latest: unknown }).latest = { kind: 'failed', reason: 'could not reach npm' };

    const view = await service.view();

    should(view.check).containEql({ state: 'failed', reason: 'could not reach npm' });
    should(view.available).be.true();
  });

  it('shows nothing to update when claude is not found', async () => {
    const world = new World();
    world.location = { outcome: 'absent', searched: ['/usr/bin'] };

    const view = await world.service().view();

    should(view.location).eql({ state: 'absent', searched: ['/usr/bin'] });
    should(view.method).be.null();
    should(view.plan).be.null();
    should(view.available).be.false();
  });
});

describe('HarnessUpdateService.start', () => {
  it('updates, checks the new binary starts, and reports the move', async () => {
    const world = new World();
    world.script = [world.installs('2.1.220')];
    const service = world.service();

    const running = await service.start({ target: '2.1.220' });
    const after = await finished(service);

    should(running.job?.state).equal('running');
    should(world.runs[0]).containEql({
      program: `${PREFIX}/bin/npm`,
      args: ['install', '-g', '--prefix', PREFIX, '@anthropic-ai/claude-code@2.1.220'],
    });
    should(after.job).containEql({ state: 'finished' });
    const report = after.job?.state === 'finished' ? after.job.report : undefined;
    should(report).containEql({ outcome: 'succeeded', from: '2.1.200', to: '2.1.220', target: '2.1.220' });
    should(report?.message).containEql('Running ferrets keep the version they started with');
  });

  it('needs an explicit yes past the verified version, and says both versions', async () => {
    const world = new World();
    const service = world.service();

    const refusal = await refusalOf(service.start({}));

    should(refusal.code).equal(HARNESS_UPDATE_CODES.unverified);
    should(refusal.unverified).eql({ target: '2.1.230', verified: '2.1.220' });
    should(world.runs).eql([]);
  });

  it('goes past the verified version with the yes', async () => {
    const world = new World();
    world.script = [world.installs('2.1.230')];
    const service = world.service();

    await service.start({ confirmUnverified: true });
    const after = await finished(service);

    should(after.job?.state === 'finished' && after.job.report.outcome).equal('succeeded');
  });

  it('refuses when nothing is located, when already newest and when one is running', async () => {
    const world = new World();
    world.location = { outcome: 'absent', searched: [] };
    should((await refusalOf(world.service().start({}))).code).equal(HARNESS_UPDATE_CODES.notLocated);

    const newest = new World();
    newest.version = { state: 'ok', version: '2.1.230' };
    should((await refusalOf(newest.service().start({}))).code).equal(HARNESS_UPDATE_CODES.notAvailable);

    const busy = new World();
    const held = busy.service();
    const first = await held.start({ confirmUnverified: true });
    should(first.job?.state).equal('running');
    should((await refusalOf(held.start({ confirmUnverified: true }))).code).equal(HARNESS_UPDATE_CODES.inProgress);
    await held.settled();
  });

  it('refuses a chosen version for a method that installs what it has', async () => {
    const world = new World();
    world.resolved = '/opt/homebrew/Caskroom/claude-code/2.1.200/claude';

    const refusal = await refusalOf(world.service().start({ target: '2.1.220' }));

    should(refusal.code).equal(HARNESS_UPDATE_CODES.notTargetable);
  });

  it('will not update a method it cannot, and says the steps are manual', async () => {
    const world = new World();
    world.resolved = '/opt/x/claude';

    const refusal = await refusalOf(world.service().start({}));

    should(refusal.code).equal(HARNESS_UPDATE_CODES.notSelfUpdatable);
  });

  it('rolls back to the previous version when the new binary does not start', async () => {
    const world = new World();
    world.startup = { ok: false, reason: '--help exited 1' };
    world.script = [
      world.installs('2.1.220'),
      () => {
        world.version = { state: 'ok', version: '2.1.200' };
        world.startup = { ok: true };
        return { kind: 'exited', code: 0, tail: [] };
      },
    ];
    const service = world.service();

    await service.start({ target: '2.1.220' });
    const after = await finished(service);

    const report = after.job?.state === 'finished' ? after.job.report : undefined;
    should(report?.outcome).equal('rolled-back');
    should(world.runs.map(run => run.args.at(-1))).eql([
      '@anthropic-ai/claude-code@2.1.220',
      '@anthropic-ai/claude-code@2.1.200',
    ]);
  });

  it('says it could not put the old version back when the method keeps none', async () => {
    const world = new World();
    world.resolved = '/opt/homebrew/Caskroom/claude-code/2.1.200/claude';
    world.startup = { ok: false, reason: '--help exited 1' };
    const service = world.service();

    await service.start({ confirmUnverified: true });
    const after = await finished(service);

    const report = after.job?.state === 'finished' ? after.job.report : undefined;
    should(report?.outcome).equal('failed');
    should(report?.message).containEql('keeps no previous version');
  });

  it('reports a package manager that exits non-zero, with the last thing it said', async () => {
    const world = new World();
    world.script = [() => ({ kind: 'exited', code: 1, tail: ['npm ERR! something broke'] })];
    const service = world.service();

    await service.start({ confirmUnverified: true });
    const after = await finished(service);

    const report = after.job?.state === 'finished' ? after.job.report : undefined;
    should(report?.outcome).equal('failed');
    should(report?.message).containEql('stopped with exit code 1');
    should(report?.message).containEql('npm ERR! something broke');
  });

  it('never runs sudo: an admin-rights failure tells the person to run it themselves', async () => {
    const world = new World();
    world.script = [() => ({ kind: 'exited', code: 243, tail: ['npm ERR! code EACCES'] })];
    const service = world.service();

    await service.start({ confirmUnverified: true });
    const after = await finished(service);

    const report = after.job?.state === 'finished' ? after.job.report : undefined;
    should(report?.message).containEql('Ferretry never runs sudo');
  });
});
