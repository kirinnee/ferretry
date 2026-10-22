import { describe, it } from 'bun:test';
import {
  PACK_GUIDE_BUILDER_LABEL,
  type PackInventory,
  type PackInventoryRuntime,
  type SessionView,
  type StartSessionRequest,
} from '@ferretry/protocol';
import should from 'should';
import {
  BUILDER_NAME,
  GuideBuilderService,
  type GuideRun,
  type GuideRunStore,
  KEPT_RUNS,
} from '../../../../src/lib/pack/builder/service.ts';
import type { PackProbeOutcome, PackProbeRequest } from '../../../../src/lib/pack/probe.ts';
import { sessionView } from '../../runtime/mounts/support.ts';

const NOW = '2026-10-22T12:00:00.000Z';
const PLENTY = { state: 'plenty' as const, leftPercent: 80, windows: [], summary: '5h 2% · wk 20%' };
const LOW = { state: 'low' as const, leftPercent: 9, windows: [], summary: '5h 10% · wk 91%' };
const runtimeRow = (name: string, overrides: Partial<PackInventoryRuntime> = {}): PackInventoryRuntime => ({
  name,
  harness: 'claude',
  provider: 'anthropic',
  login: `${name}-login`,
  ready: true,
  quota: PLENTY,
  ...overrides,
});
const inventory = (runtimes: readonly PackInventoryRuntime[]): PackInventory => ({
  at: NOW,
  models: [
    {
      provider: 'anthropic',
      providerLabel: 'Anthropic',
      harness: 'claude',
      id: 'opus',
      label: 'Opus',
      tier: 'best',
      efforts: [],
      description: 'Strongest.',
      describedBy: 'owner',
      runtimes: [],
      headroom: { runtimes: 0, ready: 0, summary: 'no runtime here runs it' },
    },
  ],
  runtimes,
  guide: { source: 'derived', useCases: [] },
});
const DRAFT = JSON.stringify({
  routing: { prompt: 'Opus for everything.', short: 'Routing: all → opus.' },
  useCases: [
    {
      id: 'everyday',
      title: 'Everyday',
      description: 'Work.',
      candidates: [{ provider: 'anthropic', model: 'opus', why: 'Strongest.' }],
    },
  ],
});

class MemoryRuns implements GuideRunStore {
  readonly runs = new Map<string, GuideRun>();
  readonly files = new Map<string, string>();
  readonly removed: string[] = [];

  async save(run: GuideRun): Promise<void> {
    this.runs.set(run.job.id, run);
  }
  async load(id: string): Promise<GuideRun | undefined> {
    return this.runs.get(id);
  }
  async list(): Promise<readonly GuideRun[]> {
    return [...this.runs.values()].toSorted((left, right) => right.job.startedAt.localeCompare(left.job.startedAt));
  }
  async remove(id: string): Promise<void> {
    this.removed.push(id);
    this.runs.delete(id);
  }
  async writeFile(id: string, name: string, text: string): Promise<string> {
    this.files.set(this.pathOf(id, name), text);
    return this.pathOf(id, name);
  }
  async readFile(id: string, name: string): Promise<string | undefined> {
    return this.files.get(this.pathOf(id, name));
  }
  pathOf(id: string, name: string): string {
    return `/fy/state/pack-guide/${id}/${name}`;
  }
}

function build(
  options: {
    readonly runtimes?: readonly PackInventoryRuntime[];
    readonly probes?: Readonly<Record<string, PackProbeOutcome>>;
    readonly statuses?: Readonly<Record<string, string>>;
    readonly unknownRuntime?: string;
  } = {},
) {
  const runs = new MemoryRuns();
  const probes: PackProbeRequest[] = [];
  const starts: StartSessionRequest[] = [];
  const stops: Array<readonly [string, string]> = [];
  const statuses = new Map(Object.entries(options.statuses ?? {}));
  const preferences: Array<string | undefined> = [];
  let ids = 0;
  let clock = 0;
  const service = new GuideBuilderService({
    inventory: async asked => {
      preferences.push(asked);
      return inventory(options.runtimes ?? [runtimeRow('claude-kirin', { quota: LOW }), runtimeRow('claude-atomi')]);
    },
    guide: async () => ({ source: 'file', useCases: [] }),
    runtime: async name =>
      name === options.unknownRuntime
        ? undefined
        : { wrapper: `${name}-wrapper`, harness: 'claude', defaultModel: name === 'claude-atomi' ? 'opus' : undefined },
    probeSettings: async () => ({ timeoutSeconds: 45, cacheSeconds: 180 }),
    probe: async request => {
      probes.push(request);
      return { outcome: options.probes?.[request.wrapper] ?? { ok: true, ms: 640 }, cached: false };
    },
    start: async request => {
      starts.push(request);
      const id = `builder-${String(starts.length)}`;
      statuses.set(id, 'running');
      return { ...sessionView(id), config: { ...sessionView(id).config, teammate: 'gonzalo' } } as SessionView;
    },
    status: async session => statuses.get(session),
    stop: async (session, reason) => {
      stops.push([session, reason]);
      statuses.set(session, 'stopped');
    },
    runs,
    now: () => new Date(Date.parse(NOW) + 60_000 * clock++).toISOString(),
    newId: () => `run-${String(++ids)}`,
    home: '/fy',
    bin: 'fy',
  });
  return { service, runs, probes, starts, stops, statuses, preferences };
}

describe('GuideBuilderService.start', () => {
  it('should probe the ready runtime with the most headroom, then start a hidden builder ferret pointed at its files', async () => {
    // Arrange
    const { service, runs, probes, starts, preferences } = build();

    // Act
    const started = await service.start({ preferences: 'Opus for reviews.' });

    // Assert
    should(preferences).deepEqual(['Opus for reviews.']);
    should(probes).deepEqual([
      { wrapper: 'claude-atomi-wrapper', harness: 'claude', model: 'opus', cwd: '/fy', timeoutMs: 45_000 },
    ]);
    should(starts).have.length(1);
    should(starts[0]).containEql({
      agent: 'claude-atomi-wrapper',
      mode: 'auto',
      label: PACK_GUIDE_BUILDER_LABEL,
      name: BUILDER_NAME,
      cwd: '/fy',
      boardAccess: 'none',
      model: 'opus',
    });
    should(starts[0]?.prompt).containEql('/fy/state/pack-guide/run-1/inventory.json');
    should(starts[0]?.prompt).containEql('/fy/state/pack-guide/run-1/draft.json');
    should(started).deepEqual({
      outcome: 'started',
      job: {
        id: 'run-1',
        session: 'builder-1',
        name: 'gonzalo',
        runtime: 'claude-atomi',
        model: 'opus',
        startedAt: NOW,
        status: 'running',
      },
    });
    should(JSON.parse(runs.files.get('/fy/state/pack-guide/run-1/inventory.json') ?? '{}').runtimes).have.length(2);
  });

  it('should skip a runtime whose probe fails and start on the next, and refuse when none answers', async () => {
    // Arrange
    const fallback = build({ probes: { 'claude-atomi-wrapper': { ok: false, ms: 900, reason: 'out of quota' } } });
    const none = build({
      probes: {
        'claude-atomi-wrapper': { ok: false, ms: 900, reason: 'out of quota' },
        'claude-kirin-wrapper': { ok: false, ms: 45_000, reason: 'no answer within 45s' },
      },
    });

    // Act
    const started = await fallback.service.start({});
    const refused = await none.service.start({});

    // Assert
    should(started.outcome === 'started' && started.job.runtime).equal('claude-kirin');
    should(fallback.starts[0]).not.have.property('model');
    should(refused).deepEqual({
      outcome: 'refused',
      message:
        'No runtime answered a "reply OK" check (claude-atomi: out of quota; claude-kirin: no answer within 45s).',
    });
    should(none.starts).be.empty();
  });

  it('should run on the runtime named, and refuse one that is not there or not ready', async () => {
    // Arrange
    const subject = build({
      runtimes: [
        runtimeRow('claude-kirin'),
        runtimeRow('claude-off', {
          ready: false,
          refusal: { code: 'not_logged_in', message: 'claude-off needs signing in.' },
        }),
        runtimeRow('claude-mute', { ready: false }),
      ],
    });

    // Act
    const named = await subject.service.start({ runtime: 'claude-kirin', model: 'haiku' });
    const missing = await subject.service.start({ runtime: 'ghost' });
    const off = await subject.service.start({ runtime: 'claude-off' });
    const mute = await subject.service.start({ runtime: 'claude-mute' });

    // Assert
    should(named.outcome === 'started' && [named.job.runtime, named.job.model]).deepEqual(['claude-kirin', 'haiku']);
    should(missing).deepEqual({ outcome: 'refused', message: 'There is no agent runtime ghost on this machine.' });
    should(off).deepEqual({ outcome: 'refused', message: 'claude-off needs signing in.' });
    should(mute).deepEqual({ outcome: 'refused', message: 'claude-mute cannot start a ferret now.' });
  });

  it('should say why nothing can build a guide, and that nothing could be resolved', async () => {
    // Arrange
    const notReady = build({
      runtimes: [
        runtimeRow('claude-off', {
          ready: false,
          refusal: { code: 'out_of_quota', message: 'claude-off is out of quota.' },
        }),
      ],
    });
    const empty = build({ runtimes: [] });
    const unresolved = build({ runtimes: [runtimeRow('claude-gone')], unknownRuntime: 'claude-gone' });

    // Act + Assert
    should(await notReady.service.start({})).deepEqual({
      outcome: 'refused',
      message: 'No runtime can start a ferret now — claude-off is out of quota.',
    });
    should(await empty.service.start({})).deepEqual({
      outcome: 'refused',
      message: 'There is no agent runtime on this machine to build a guide with.',
    });
    should(await unresolved.service.start({})).deepEqual({
      outcome: 'refused',
      message: 'No runtime answered a "reply OK" check (none could be resolved).',
    });
  });

  it(`should keep the newest ${String(KEPT_RUNS)} runs and remove the older ones`, async () => {
    // Arrange
    const subject = build();

    // Act
    for (let index = 0; index < KEPT_RUNS + 2; index += 1) await subject.service.start({});

    // Assert
    should(subject.runs.removed).deepEqual(['run-1', 'run-2']);
    should([...subject.runs.runs.keys()]).have.length(KEPT_RUNS);
  });
});

describe('GuideBuilderService.job', () => {
  it('should stay running until the draft is written, then check it, keep the suggestion and stop the ferret', async () => {
    // Arrange
    const subject = build();
    await subject.service.start({});

    // Act
    const waiting = await subject.service.job('run-1');
    await subject.runs.writeFile('run-1', 'draft.json', DRAFT);
    const done = await subject.service.job('run-1');
    const again = await subject.service.job('run-1');

    // Assert
    should(waiting?.job.status).equal('running');
    should(done?.job.status).equal('suggested');
    should(done?.suggestion).deepEqual({
      suggested: { by: 'opus', via: 'claude-atomi', at: done?.suggestion?.suggested.at },
      routing: { prompt: 'Opus for everything.', short: 'Routing: all → opus.' },
      useCases: JSON.parse(DRAFT).useCases,
      dropped: [],
      flagged: [],
      current: { source: 'file', useCases: [] },
    });
    should(subject.stops).deepEqual([['builder-1', 'the models guide it drafted has been read']]);
    should(again).deepEqual(done);
    should(await subject.service.job('nope')).be.undefined();
  });

  it('should keep a suggestion even when stopping its finished ferret fails', async () => {
    // Arrange
    const subject = build();
    await subject.service.start({});
    await subject.runs.writeFile('run-1', 'draft.json', DRAFT);
    const broken = new GuideBuilderService({
      ...(subject.service as unknown as { ports: ConstructorParameters<typeof GuideBuilderService>[0] }).ports,
      stop: async () => {
        throw new Error('the pane is gone');
      },
    });

    // Act
    const done = await broken.job('run-1');

    // Assert
    should(done?.job.status).equal('suggested');
  });

  it('should wait on a draft that does not read while the ferret runs, and fail it once the ferret is done', async () => {
    // Arrange
    const subject = build();
    await subject.service.start({});
    await subject.runs.writeFile('run-1', 'draft.json', '{"useCases": [');

    // Act
    const partial = await subject.service.job('run-1');
    subject.statuses.set('builder-1', 'completed');
    const failed = await subject.service.job('run-1');

    // Assert
    should(partial?.job.status).equal('running');
    should(failed?.job).containEql({
      status: 'failed',
      message: 'the builder did not write a guide: its file is not a JSON object with "useCases".',
    });
    should(subject.stops).be.empty();
  });

  it('should fail a run whose ferret ended, or vanished, without writing a draft, and name the builder by runtime when no model', async () => {
    // Arrange
    const ended = build();
    const vanished = build({ runtimes: [runtimeRow('claude-kirin')] });
    await ended.service.start({});
    await vanished.service.start({});
    ended.statuses.set('builder-1', 'failed');
    vanished.statuses.delete('builder-1');

    // Act
    const failed = await ended.service.job('run-1');
    const gone = await vanished.service.job('run-1');

    // Assert
    should(failed?.job.message).equal('The builder failed without writing a guide.');
    should(gone?.job.message).equal('The builder ended without writing a guide.');
  });

  it('should judge a draft against nothing when the inventory it was shown cannot be read', async () => {
    // Arrange
    const subject = build({ runtimes: [runtimeRow('claude-kirin')] });
    await subject.service.start({});
    await subject.runs.writeFile('run-1', 'inventory.json', 'not json');
    await subject.runs.writeFile('run-1', 'draft.json', DRAFT);
    subject.statuses.set('builder-1', 'completed');

    // Act
    const result = await subject.service.job('run-1');

    // Assert — every candidate names a model the (unreadable) inventory does not list, so nothing survives
    should(result?.job.status).equal('suggested');
    should(result?.suggestion?.dropped).have.length(1);
    should(result?.suggestion?.suggested.by).equal('claude-kirin');
  });
});

describe('GuideBuilderService.status', () => {
  it('should offer the ready runtimes by headroom and the newest run, or say why none', async () => {
    // Arrange
    const subject = build();
    const none = build({
      runtimes: [
        runtimeRow('claude-off', {
          ready: false,
          refusal: { code: 'not_logged_in', message: 'claude-off needs signing in.' },
        }),
      ],
    });
    await subject.service.start({});

    // Act + Assert
    should(await subject.service.status()).containDeep({
      available: true,
      runtimes: ['claude-atomi', 'claude-kirin'],
      job: { id: 'run-1', status: 'running' },
    });
    should(await none.service.status()).deepEqual({
      available: false,
      runtimes: [],
      reason: 'No runtime can start a ferret now — claude-off needs signing in.',
    });
  });
});
