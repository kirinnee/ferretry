import { describe, it } from 'bun:test';
import { instantFromEpochMs } from '@ferretry/std';
import {
  DAEMON_UPDATE_CODES,
  type InstallFacts,
  type LatestRelease,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateCheck,
  UpdateCheckSchema,
  type UpdateReport,
  UpdateReportSchema,
} from '../../contract/index.ts';
import should from 'should';
import {
  DaemonUpdateRefusal,
  DaemonUpdateService,
  type DaemonUpdateServiceOptions,
  UPDATE_REPORT_TIMEOUT_MS,
} from '../../daemon/lib/service.ts';
import type { LatestReleaseAnswer, UpdateDocuments, UpdateLaunchOutcome } from '../../daemon/lib/ports.ts';

const NOW = Date.parse('2026-10-18T10:00:00.000Z');
const LATEST: LatestRelease = { version: '4.29.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0' };
const STORE = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-ferretry-4.28.0';

const PROFILE_FACTS: InstallFacts = {
  product: 'ferretry',
  compiled: true,
  launchedPath: '/home/kirin/.nix-profile/bin/fyd',
  resolvedPath: `${STORE}/bin/fyd`,
  homeDirectory: '/home/kirin',
  platform: 'linux',
  nixProfileElement: 'ferretry',
};
const MODULE_FACTS: InstallFacts = { ...PROFILE_FACTS, nixProfileElement: undefined, homeManagerProfile: true };

class MemoryDocuments implements UpdateDocuments {
  readonly store = new Map<'latest' | 'report', unknown>();
  failWrites = false;
  async readLatest(): Promise<UpdateCheck | undefined> {
    const parsed = UpdateCheckSchema.safeParse(this.store.get('latest'));
    return parsed.success ? parsed.data : undefined;
  }
  async writeLatest(check: UpdateCheck): Promise<void> {
    if (this.failWrites) throw new Error('disk full');
    this.store.set('latest', check);
  }
  async readReport(): Promise<UpdateReport | undefined> {
    const parsed = UpdateReportSchema.safeParse(this.store.get('report'));
    return parsed.success ? parsed.data : undefined;
  }
  async removeReport(): Promise<void> {
    this.store.delete('report');
  }
}

interface World {
  readonly service: DaemonUpdateService;
  readonly documents: MemoryDocuments;
  readonly launched: string[];
  readonly asked: { count: number };
  readonly clock: { now: number };
  readonly activity: { midTurn: number };
  readonly answers: LatestReleaseAnswer[];
  readonly setting: { autoInstall: boolean };
}

function world(
  options: {
    facts?: InstallFacts;
    answers?: LatestReleaseAnswer[];
    launch?: UpdateLaunchOutcome;
    current?: string;
    intervalMs?: number;
    checks?: boolean;
  } = {},
): World {
  const documents = new MemoryDocuments();
  const launched: string[] = [];
  const asked = { count: 0 };
  const clock = { now: NOW };
  const activity = { midTurn: 0 };
  const answers = options.answers ?? [{ kind: 'ok', release: LATEST }];
  const setting = { autoInstall: false };
  const serviceOptions: DaemonUpdateServiceOptions = {
    current: options.current ?? '4.28.0',
    product: 'ferretry',
    clientName: 'fy',
    install: { facts: async () => options.facts ?? PROFILE_FACTS },
    releases: {
      latest: async () => {
        asked.count += 1;
        return answers[Math.min(asked.count, answers.length) - 1] as LatestReleaseAnswer;
      },
    },
    documents,
    autoInstall: { current: () => setting.autoInstall },
    launcher: {
      launch: async target => {
        launched.push(target);
        return options.launch ?? { kind: 'started' };
      },
    },
    activity: { midTurn: async () => activity.midTurn },
    clock: { now: () => clock.now },
    checks: options.checks ?? true,
    ...(options.intervalMs === undefined ? {} : { checkIntervalMs: options.intervalMs }),
  };
  const service = new DaemonUpdateService(serviceOptions);
  return { service, documents, launched, asked, clock, activity, answers, setting };
}

const report = (overrides: Partial<UpdateReport> = {}): UpdateReport => ({
  from: '4.28.0',
  target: '4.29.0',
  outcome: 'succeeded',
  message: 'Updated to 4.29.0.',
  finishedAt: instantFromEpochMs(NOW + 1_000),
  ...overrides,
});

/** Turns installing on the way the config watch does: the setting first, then the service is told. */
async function turnOn(world: { readonly service: DaemonUpdateService; readonly setting: { autoInstall: boolean } }) {
  world.setting.autoInstall = true;
  world.service.autoInstallTurnedOn();
  return await world.service.view();
}

async function refusal(work: Promise<unknown>): Promise<DaemonUpdateRefusal> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.instanceOf(DaemonUpdateRefusal);
  return error as DaemonUpdateRefusal;
}

describe('the update check', () => {
  it('has asked nobody before the first tick, and says so', async () => {
    const { service, asked } = world();
    const view = await service.view();
    should(view).containDeep({ current: '4.28.0', check: { state: 'never' }, available: false, job: null });
    should(view.method).deepEqual({ kind: 'nix-profile', element: 'ferretry' });
    should(view.plan.kind).equal('self');
    should(asked.count).equal(0);
  });

  it('asks at boot, caches the answer, and asks again only after the interval', async () => {
    const { service, documents, asked, clock } = world();
    await service.tick();
    should(asked.count).equal(1);
    should(documents.store.get('latest')).containDeep({ state: 'ok', latest: LATEST });
    should((await service.view()).available).be.true();

    clock.now += UPDATE_CHECK_INTERVAL_MS - 1;
    await service.tick();
    should(asked.count).equal(1);

    clock.now += 1;
    await service.tick();
    should(asked.count).equal(2);
  });

  it('reuses a fresh answer a previous boot left on disk', async () => {
    const first = world();
    await first.service.tick();
    const second = world();
    for (const [name, document] of first.documents.store) second.documents.store.set(name, document);
    await second.service.tick();
    should(second.asked.count).equal(0);
    should((await second.service.view()).available).be.true();
  });

  it('reads a damaged document as never checked', async () => {
    const { service, documents } = world();
    documents.store.set('latest', { state: 'ok' });
    documents.store.set('report', { outcome: 'odd' });
    should(await service.view()).containDeep({ check: { state: 'never' }, autoInstall: false, job: null });
  });

  it('keeps the last good answer through failures, and survives a write that fails', async () => {
    const { service, documents, clock } = world({
      intervalMs: 10,
      answers: [
        { kind: 'ok', release: LATEST },
        { kind: 'failed', reason: 'could not reach GitHub' },
        { kind: 'failed', reason: 'GitHub answered 500' },
      ],
    });
    await service.tick();
    clock.now += 10;
    await service.tick();
    const failed = await service.view();
    should(failed.check).containDeep({
      state: 'failed',
      reason: 'could not reach GitHub',
      lastKnown: { latest: LATEST },
    });
    should(failed.available).be.true();
    clock.now += 10;
    documents.failWrites = true;
    await service.tick();
    should((await service.view()).check).containDeep({
      state: 'failed',
      reason: 'GitHub answered 500',
      lastKnown: { latest: LATEST },
    });
  });

  it('says a failure with nothing known before it, without inventing a last answer', async () => {
    const { service } = world({ answers: [{ kind: 'failed', reason: 'could not reach GitHub' }] });
    await service.tick();
    const view = await service.view();
    should(view.check).not.have.property('lastKnown');
    should(view.available).be.false();
  });

  it('asks once when two passes race', async () => {
    const { service, asked } = world();
    await Promise.all([service.tick(), service.tick()]);
    should(asked.count).equal(1);
  });

  it('turns a failed pass into nothing', async () => {
    const { service, documents } = world();
    documents.readLatest = async () => {
      throw new Error('unreadable');
    };
    await service.tick();
  });
});

describe('starting an update', () => {
  it('neither offers, auto-installs nor starts a newer major', async () => {
    const nextMajor = { ...LATEST, version: '6.0.0' };
    const w = world({ current: '5.0.3', answers: [{ kind: 'ok', release: nextMajor }] });
    const { service, launched } = w;
    await turnOn(w);
    await service.tick();
    should((await service.view()).available).be.false();
    should((await refusal(service.start({ target: '6.0.0', when: 'now' }))).code).equal(
      DAEMON_UPDATE_CODES.notAvailable,
    );
    should(launched).deepEqual([]);
  });

  it('refuses a method that cannot update itself', async () => {
    const { service } = world({ facts: MODULE_FACTS });
    await service.tick();
    const error = await refusal(service.start({ target: '4.29.0', when: 'now' }));
    should(error.code).equal(DAEMON_UPDATE_CODES.notSelfUpdatable);
  });

  it('refuses when no newer release is known, and a target that is not the latest', async () => {
    const { service } = world();
    should((await refusal(service.start({ target: '4.29.0', when: 'now' }))).code).equal(
      DAEMON_UPDATE_CODES.notAvailable,
    );
    await service.tick();
    const stale = await refusal(service.start({ target: '4.28.5', when: 'now' }));
    should(stale.code).equal(DAEMON_UPDATE_CODES.staleTarget);
    should(stale.message).match(/the latest is 4\.29\.0/u);
  });

  it('refuses when this daemon already runs the latest', async () => {
    const { service } = world({ current: '4.29.0' });
    await service.tick();
    should((await refusal(service.start({ target: '4.29.0', when: 'now' }))).code).equal(
      DAEMON_UPDATE_CODES.notAvailable,
    );
  });

  it('starts now when nobody is mid-turn, and refuses a second update while it runs', async () => {
    const { service, documents, launched } = world();
    await service.tick();
    documents.store.set('report', report({ finishedAt: instantFromEpochMs(NOW - 60_000) }));
    const view = await service.start({ target: '4.29.0', when: 'now' });
    should(launched).deepEqual(['4.29.0']);
    should(documents.store.has('report')).be.false();
    should(view.job).deepEqual({ state: 'running', target: '4.29.0', startedAt: instantFromEpochMs(NOW) });
    const again = await refusal(service.start({ target: '4.29.0', when: 'now' }));
    should(again.code).equal(DAEMON_UPDATE_CODES.inProgress);
    should(again.message).match(/already running/u);
  });

  it('updates now with ferrets mid-turn, because they keep running through the restart', async () => {
    const { service, launched, activity } = world();
    await service.tick();
    activity.midTurn = 2;
    const view = await service.start({ target: '4.29.0', when: 'now' });
    should(launched).deepEqual(['4.29.0']);
    should(view.job).containDeep({ state: 'running', target: '4.29.0' });
    should(view.midTurn).equal(2);
  });

  it('waits for idle, then starts on the first idle pass', async () => {
    const { service, launched, activity } = world();
    await service.tick();
    activity.midTurn = 1;
    const waiting = await service.start({ target: '4.29.0', when: 'when-idle' });
    should(waiting.job).containDeep({ state: 'waiting-for-idle', target: '4.29.0', midTurn: 1 });
    should((await refusal(service.start({ target: '4.29.0', when: 'now' }))).message).match(/waiting for the ferrets/u);
    await service.tick();
    should(launched).deepEqual([]);
    activity.midTurn = 0;
    await service.tick();
    should(launched).deepEqual(['4.29.0']);
  });

  it('starts at once when asked to wait for idle and nobody is busy', async () => {
    const { service, launched } = world();
    await service.tick();
    await service.start({ target: '4.29.0', when: 'when-idle' });
    should(launched).deepEqual(['4.29.0']);
  });

  it('reports a launch that could not start as a finished failure', async () => {
    const { service } = world({ launch: { kind: 'failed', reason: 'fy is not beside the daemon' } });
    await service.tick();
    const view = await service.start({ target: '4.29.0', when: 'now' });
    should(view.job).containDeep({
      state: 'finished',
      report: {
        outcome: 'failed',
        target: '4.29.0',
        message: 'The update could not start: fy is not beside the daemon.',
      },
    });
  });
});

describe('the job', () => {
  it('picks up the report the client leaves, from this boot or the last one', async () => {
    const { service, documents } = world();
    await service.tick();
    await service.start({ target: '4.29.0', when: 'now' });
    documents.store.set('report', report({ outcome: 'rolled-back', message: 'Rolled back.' }));
    should((await service.view()).job).deepEqual({
      state: 'finished',
      report: report({ outcome: 'rolled-back', message: 'Rolled back.' }),
    });
    const next = world();
    next.documents.store.set('report', report());
    should((await next.service.view()).job).deepEqual({ state: 'finished', report: report() });
  });

  it('ignores a report older than the update it is waiting on', async () => {
    const { service, documents } = world();
    await service.tick();
    await service.start({ target: '4.29.0', when: 'now' });
    documents.store.set('report', report({ finishedAt: instantFromEpochMs(NOW - 1) }));
    should((await service.view()).job?.state).equal('running');
  });

  it('calls an update that never reports back failed, so the next can start', async () => {
    const { service, clock, launched } = world();
    await service.tick();
    await service.start({ target: '4.29.0', when: 'now' });
    clock.now += UPDATE_REPORT_TIMEOUT_MS + 1;
    should((await service.view()).job).containDeep({ state: 'finished', report: { outcome: 'failed' } });
    await service.start({ target: '4.29.0', when: 'now' });
    should(launched).deepEqual(['4.29.0', '4.29.0']);
  });
});

describe('installing automatically when idle', () => {
  it('is off by default, and on once turned on', async () => {
    const { service, setting } = world();
    should((await service.view()).autoInstall).be.false();
    should((await turnOn({ service, setting })).autoInstall).be.true();
  });

  it('starts the latest release only when on, available, self-updatable and idle', async () => {
    const off = world();
    await off.service.tick();
    should(off.launched).deepEqual([]);

    const busy = world();
    await turnOn(busy);
    busy.activity.midTurn = 1;
    await busy.service.tick();
    should(busy.launched).deepEqual([]);
    busy.activity.midTurn = 0;
    await busy.service.tick();
    should(busy.launched).deepEqual(['4.29.0']);
    await busy.service.tick();
    should(busy.launched).deepEqual(['4.29.0']);

    const module = world({ facts: MODULE_FACTS });
    await turnOn(module);
    await module.service.tick();
    should(module.launched).deepEqual([]);

    const current = world({ current: '4.29.0' });
    await turnOn(current);
    await current.service.tick();
    should(current.launched).deepEqual([]);

    const unknown = world({ answers: [{ kind: 'failed', reason: 'offline' }] });
    await turnOn(unknown);
    await unknown.service.tick();
    should(unknown.launched).deepEqual([]);
  });

  it('never retries a release the last attempt failed or rolled back', async () => {
    const { service, documents, launched, setting } = world();
    documents.store.set('report', report({ outcome: 'rolled-back' }));
    await turnOn({ service, setting });
    await service.tick();
    should(launched).deepEqual([]);
    documents.store.set('report', report({ target: '4.28.5', outcome: 'failed' }));
    await service.tick();
    should(launched).deepEqual(['4.29.0']);
  });
});

describe('looking again when a turn may have ended', () => {
  it('launches a waiting update on the first state write after the last turn ends', async () => {
    // Arrange — a release is known, and a ferret is mid-turn when the update is asked for.
    const { service, launched, activity } = world();
    await service.tick();
    activity.midTurn = 1;
    await service.start({ target: '4.29.0', when: 'when-idle' });

    // Act — a write while still mid-turn, then the write that ends the turn.
    service.activityChanged();
    await service.tick();
    should(launched).deepEqual([]);
    activity.midTurn = 0;
    service.activityChanged();
    await service.tick();

    // Assert
    should(launched).deepEqual(['4.29.0']);
  });

  it('looks at nothing when no update is waiting on idle', async () => {
    // Arrange
    const { service, asked, launched } = world();
    await service.tick();
    const before = asked.count;

    // Act
    service.activityChanged();
    await service.tick();

    // Assert — no launch, and the joined pass asked nobody again inside the interval.
    should(launched).deepEqual([]);
    should(asked.count).equal(before);
  });

  it('installs automatically at the next idle moment once turned on', async () => {
    // Arrange — mid-turn when the setting is turned on.
    const { service, launched, activity, setting } = world();
    await service.tick();
    activity.midTurn = 2;
    await turnOn({ service, setting });
    await service.tick();
    should(launched).deepEqual([]);

    // Act
    activity.midTurn = 0;
    service.activityChanged();
    await service.tick();

    // Assert
    should(launched).deepEqual(['4.29.0']);
  });

  it('joins a pass already running rather than starting a second', async () => {
    // Arrange
    const { service, asked } = world();

    // Act
    const first = service.tick();
    const second = service.tick();
    await Promise.all([first, second]);

    // Assert
    should(asked.count).equal(1);
  });
});

describe('a daemon that does not check', () => {
  it('never asks, but still reads what an earlier check left', async () => {
    const { service, asked } = world({ checks: false });
    await service.tick();
    should(asked.count).equal(0);
    should((await service.view()).check).deepEqual({ state: 'never' });
  });
});
