import { describe, it } from 'bun:test';
import {
  PACK_CLEAN_UP_LABEL,
  type PackInventory,
  type PackInventoryRuntime,
  type SessionView,
  type StartSessionRequest,
} from '@ferretry/protocol';
import should from 'should';
import {
  CLEAN_UP_NAME,
  GENERATE_NAME,
  type CleanUpRun,
  type CleanUpRunStore,
  CleanUpService,
  KEPT_RUNS,
} from '../../../../src/lib/pack/cleanup/service.ts';
import type { PackProbeOutcome, PackProbeRequest } from '../../../../src/lib/pack/probe.ts';
import { sessionView } from '../../runtime/mounts/support.ts';

const NOW = '2026-10-22T12:00:00.000Z';
const IN_EFFECT = 'Opus for everything I do.';
const PLENTY = { state: 'plenty' as const, leftPercent: 80, windows: [], summary: '5h 2% · wk 20%' };
const LOW = { state: 'low' as const, leftPercent: 9, windows: [], summary: '5h 10% · wk 91%' };
const runtimeRow = (name: string, overrides: Partial<PackInventoryRuntime> = {}): PackInventoryRuntime => ({
  name,
  harness: 'claude',
  provider: 'anthropic',
  login: `${name}-login`,
  ready: true,
  quota: PLENTY,
  models: ['opus'],
  ...overrides,
});
const inventory = (runtimes: readonly PackInventoryRuntime[], source: 'file' | 'default' = 'file'): PackInventory => ({
  at: NOW,
  runtimes,
  models: [
    {
      provider: 'anthropic',
      harness: 'claude',
      id: 'opus',
      label: 'Opus',
      tier: 'best',
      efforts: [],
      runtimes: runtimes.map(runtime => ({ name: runtime.name, ready: runtime.ready })),
    },
  ],
  routing: { text: source === 'default' ? 'The built-in default.' : IN_EFFECT, source },
});
const DRAFT = JSON.stringify({
  prompt: 'Planning and review: opus. Chores: claude-ghost-9.',
  notes: ['Add a login for a cheaper model.'],
});

class MemoryRuns implements CleanUpRunStore {
  readonly runs = new Map<string, CleanUpRun>();
  readonly files = new Map<string, string>();
  readonly removed: string[] = [];

  async save(run: CleanUpRun): Promise<void> {
    this.runs.set(run.job.id, run);
  }
  async load(id: string): Promise<CleanUpRun | undefined> {
    return this.runs.get(id);
  }
  async list(): Promise<readonly CleanUpRun[]> {
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
    return `/fy/state/pack-cleanup/${id}/${name}`;
  }
}

function build(
  options: {
    readonly runtimes?: readonly PackInventoryRuntime[];
    readonly probes?: Readonly<Record<string, PackProbeOutcome>>;
    readonly unknownRuntime?: string;
    readonly stopFails?: boolean;
    readonly routingSource?: 'file' | 'default';
  } = {},
) {
  const runs = new MemoryRuns();
  const probes: PackProbeRequest[] = [];
  const starts: StartSessionRequest[] = [];
  const stops: Array<readonly [string, string]> = [];
  const statuses = new Map<string, string>();
  let ids = 0;
  let clock = 0;
  const service = new CleanUpService({
    inventory: async () =>
      inventory(
        options.runtimes ?? [runtimeRow('claude-kirin', { quota: LOW }), runtimeRow('claude-atomi')],
        options.routingSource,
      ),
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
      const id = `cleanup-${String(starts.length)}`;
      statuses.set(id, 'running');
      return { ...sessionView(id), config: { ...sessionView(id).config, teammate: 'gonzalo' } } as SessionView;
    },
    status: async session => statuses.get(session),
    stop: async (session, reason) => {
      if (options.stopFails === true) throw new Error('the pane is gone');
      stops.push([session, reason]);
      statuses.set(session, 'stopped');
    },
    runs,
    now: () => new Date(Date.parse(NOW) + 60_000 * clock++).toISOString(),
    newId: () => `run-${String(++ids)}`,
    home: '/fy',
    bin: 'fy',
  });
  return { service, runs, probes, starts, stops, statuses };
}

describe('CleanUpService.start', () => {
  it('should probe the ready runtime with the most headroom, then start a hidden ferret whose brief names the files it was given', async () => {
    // Arrange
    const { service, runs, probes, starts } = build();

    // Act
    const started = await service.start({ prompt: 'rough: opus, i guess' });

    // Assert
    should(probes).deepEqual([
      { wrapper: 'claude-atomi-wrapper', harness: 'claude', model: 'opus', cwd: '/fy', timeoutMs: 45_000 },
    ]);
    should(starts).have.length(1);
    should(starts[0]).containEql({
      agent: 'claude-atomi-wrapper',
      mode: 'auto',
      label: PACK_CLEAN_UP_LABEL,
      name: CLEAN_UP_NAME,
      cwd: '/fy',
      boardAccess: 'none',
      model: 'opus',
    });
    should(starts[0]?.prompt).containEql('/fy/state/pack-cleanup/run-1/rough.txt');
    should(starts[0]?.prompt).containEql('/fy/state/pack-cleanup/run-1/inventory.json');
    should(starts[0]?.prompt).containEql('/fy/state/pack-cleanup/run-1/draft.json');
    should(started).deepEqual({
      outcome: 'started',
      job: {
        id: 'run-1',
        session: 'cleanup-1',
        name: 'gonzalo',
        runtime: 'claude-atomi',
        model: 'opus',
        startedAt: NOW,
        status: 'running',
      },
    });
    should(runs.files.get('/fy/state/pack-cleanup/run-1/rough.txt')).equal('rough: opus, i guess\n');
    const written = JSON.parse(runs.files.get('/fy/state/pack-cleanup/run-1/inventory.json') ?? '{}');
    should(written.runtimes).have.length(2);
    should(written.routing).deepEqual({ text: IN_EFFECT, source: 'file' });
  });

  it('should clean up the prompt in effect when no rough prompt is given', async () => {
    // Arrange
    const { service, runs } = build();

    // Act
    await service.start({});

    // Assert
    should(runs.files.get('/fy/state/pack-cleanup/run-1/rough.txt')).equal(`${IN_EFFECT}\n`);
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
    should(fallback.probes.map(probe => probe.wrapper)).deepEqual(['claude-atomi-wrapper', 'claude-kirin-wrapper']);
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
    should(subject.probes.map(probe => probe.wrapper)).deepEqual(['claude-kirin-wrapper']);
  });

  it('should say why nothing can clean up, and that nothing could be resolved', async () => {
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
      message: 'There is no agent runtime on this machine to clean up with.',
    });
    should(await unresolved.service.start({})).deepEqual({
      outcome: 'refused',
      message: 'No runtime answered a "reply OK" check (none could be resolved).',
    });
    should(notReady.starts).be.empty();
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

describe('CleanUpService.start in generate mode', () => {
  it('should write the idea and the saved prompt, name the writer and brief it with the idea file', async () => {
    // Arrange
    const { service, runs, starts } = build();

    // Act
    const started = await service.start({ mode: 'generate', idea: 'cheap models for chores' });

    // Assert
    should(starts[0]).containEql({ name: GENERATE_NAME, label: PACK_CLEAN_UP_LABEL, boardAccess: 'none' });
    should(starts[0]?.prompt).containEql('/fy/state/pack-cleanup/run-1/idea.txt');
    should(starts[0]?.prompt).containEql("You write the routing prompt for Ferretry's Pack mode");
    should(runs.files.get('/fy/state/pack-cleanup/run-1/idea.txt')).equal('cheap models for chores\n');
    should(runs.files.get('/fy/state/pack-cleanup/run-1/rough.txt')).equal(`${IN_EFFECT}\n`);
    should(started.outcome === 'started' && started.job.mode).equal('generate');
  });

  it('should write empty idea and prompt files when there is no idea and only a default in effect', async () => {
    // Arrange
    const { service, runs } = build({ routingSource: 'default' });

    // Act
    await service.start({ mode: 'generate' });

    // Assert
    should(runs.files.get('/fy/state/pack-cleanup/run-1/idea.txt')).equal('');
    should(runs.files.get('/fy/state/pack-cleanup/run-1/rough.txt')).equal('');
  });

  it('should build on the prompt given, even when only a default is in effect', async () => {
    // Arrange
    const { service, runs } = build({ routingSource: 'default' });

    // Act
    await service.start({ mode: 'generate', prompt: 'Opus for planning.' });

    // Assert
    should(runs.files.get('/fy/state/pack-cleanup/run-1/rough.txt')).equal('Opus for planning.\n');
  });

  it('should not mark a clean-up job with a mode, nor write an idea file', async () => {
    // Arrange
    const { service, runs } = build();

    // Act
    const started = await service.start({ mode: 'clean-up', idea: 'ignored' });

    // Assert
    should(started.outcome === 'started' && started.job).not.have.property('mode');
    should(runs.files.has('/fy/state/pack-cleanup/run-1/idea.txt')).be.false();
  });
});

describe('CleanUpService.job', () => {
  it('should stay running until the draft is written, then check it, keep the suggestion with before and after and stop the ferret', async () => {
    // Arrange
    const subject = build();
    await subject.service.start({ prompt: 'rough: opus' });

    // Act
    const waiting = await subject.service.job('run-1');
    await subject.runs.writeFile('run-1', 'draft.json', DRAFT);
    const done = await subject.service.job('run-1');
    const again = await subject.service.job('run-1');

    // Assert
    should(waiting?.job.status).equal('running');
    should(waiting?.suggestion).be.undefined();
    should(done?.job.status).equal('suggested');
    should(done?.suggestion).deepEqual({
      suggested: { by: 'opus', via: 'claude-atomi', at: done?.suggestion?.suggested.at },
      before: 'rough: opus',
      after: 'Planning and review: opus. Chores: claude-ghost-9.',
      notes: [
        {
          kind: 'unknown_model',
          model: 'claude-ghost-9',
          message: 'claude-ghost-9 is not a model any catalog here lists, so an automatic start cannot use it.',
        },
        { kind: 'suggestion', message: 'Add a login for a cheaper model.' },
      ],
    });
    should(subject.stops).deepEqual([['cleanup-1', 'the routing prompt it cleaned up has been read']]);
    should(again).deepEqual(done);
    should(await subject.service.job('nope')).be.undefined();
  });

  it('should show the runtime as who suggested it when the run named no model', async () => {
    // Arrange
    const subject = build({ runtimes: [runtimeRow('claude-kirin')] });
    await subject.service.start({});
    await subject.runs.writeFile('run-1', 'draft.json', JSON.stringify({ prompt: 'Opus for all.' }));

    // Act
    const done = await subject.service.job('run-1');

    // Assert
    should(done?.suggestion?.suggested.by).equal('claude-kirin');
    should(done?.suggestion?.before).equal(IN_EFFECT);
    should(done?.suggestion?.notes).deepEqual([]);
  });

  it('should set the after text as the before when the rough file is gone', async () => {
    // Arrange
    const subject = build();
    await subject.service.start({});
    subject.runs.files.delete('/fy/state/pack-cleanup/run-1/rough.txt');
    await subject.runs.writeFile('run-1', 'draft.json', JSON.stringify({ prompt: 'Opus for all.' }));

    // Act
    const done = await subject.service.job('run-1');

    // Assert
    should(done?.suggestion?.before).equal('Opus for all.');
  });

  it('should keep a suggestion even when stopping its finished ferret fails', async () => {
    // Arrange
    const subject = build({ stopFails: true });
    await subject.service.start({});
    await subject.runs.writeFile('run-1', 'draft.json', DRAFT);

    // Act
    const done = await subject.service.job('run-1');

    // Assert
    should(done?.job.status).equal('suggested');
  });

  it('should not stop a ferret that has already finished', async () => {
    // Arrange
    const subject = build();
    await subject.service.start({});
    await subject.runs.writeFile('run-1', 'draft.json', DRAFT);
    subject.statuses.set('cleanup-1', 'completed');

    // Act
    const done = await subject.service.job('run-1');

    // Assert
    should(done?.job.status).equal('suggested');
    should(subject.stops).be.empty();
  });

  it('should wait on a draft that does not read while the ferret runs, and fail it once the ferret is done', async () => {
    // Arrange
    const subject = build();
    await subject.service.start({});
    await subject.runs.writeFile('run-1', 'draft.json', '{"prompt": ');

    // Act
    const partial = await subject.service.job('run-1');
    subject.statuses.set('cleanup-1', 'completed');
    const failed = await subject.service.job('run-1');

    // Assert
    should(partial?.job.status).equal('running');
    should(failed?.job).containEql({
      status: 'failed',
      message: 'the clean-up did not write a prompt: its file is not a JSON object with "prompt".',
    });
    should(subject.stops).be.empty();
  });

  it('should fail a run whose ferret ended, or vanished, without writing a draft', async () => {
    // Arrange
    const ended = build();
    const vanished = build({ runtimes: [runtimeRow('claude-kirin')] });
    await ended.service.start({});
    await vanished.service.start({});
    ended.statuses.set('cleanup-1', 'failed');
    vanished.statuses.delete('cleanup-1');

    // Act
    const failed = await ended.service.job('run-1');
    const gone = await vanished.service.job('run-1');

    // Assert
    should(failed?.job.status).equal('failed');
    should(failed?.job.message).equal('The clean-up failed without writing a prompt.');
    should(gone?.job.message).equal('The clean-up ended without writing a prompt.');
  });

  it('should fail a run whose rewrite is empty once the ferret is done', async () => {
    // Arrange
    const subject = build();
    await subject.service.start({});
    await subject.runs.writeFile('run-1', 'draft.json', JSON.stringify({ prompt: '   ' }));
    subject.statuses.set('cleanup-1', 'completed');

    // Act
    const failed = await subject.service.job('run-1');

    // Assert
    should(failed?.job).containEql({ status: 'failed', message: 'the clean-up wrote an empty prompt.' });
  });

  it('should judge a draft against nothing when the inventory it was shown cannot be read', async () => {
    // Arrange
    const subject = build({ runtimes: [runtimeRow('claude-kirin')] });
    await subject.service.start({});
    await subject.runs.writeFile('run-1', 'inventory.json', 'not json');
    await subject.runs.writeFile('run-1', 'draft.json', DRAFT);
    subject.statuses.set('cleanup-1', 'completed');

    // Act
    const result = await subject.service.job('run-1');

    // Assert
    should(result?.job.status).equal('suggested');
    should(result?.suggestion?.suggested.by).equal('claude-kirin');
    should(result?.suggestion?.notes.map(note => note.kind)).deepEqual(['unknown_model', 'suggestion']);
  });
});

describe('CleanUpService.job in generate mode', () => {
  it('should suggest a prompt with an empty before when none was there to build on, marked as written', async () => {
    // Arrange
    const subject = build({ routingSource: 'default' });
    await subject.service.start({ mode: 'generate', idea: 'cheap chores' });
    await subject.runs.writeFile('run-1', 'draft.json', DRAFT);

    // Act
    const done = await subject.service.job('run-1');

    // Assert
    should(done?.job).containEql({ status: 'suggested', mode: 'generate' });
    should(done?.suggestion?.before).equal('');
    should(done?.suggestion?.after).equal('Planning and review: opus. Chores: claude-ghost-9.');
    should(done?.suggestion?.suggested).containEql({ mode: 'generate', via: 'claude-atomi' });
    should(done?.suggestion?.notes.map(note => note.kind)).deepEqual(['unknown_model', 'suggestion']);
    should(subject.stops).deepEqual([['cleanup-1', 'the routing prompt it wrote has been read']]);
  });

  it('should keep the saved prompt as before when one existed', async () => {
    // Arrange
    const subject = build();
    await subject.service.start({ mode: 'generate' });
    await subject.runs.writeFile('run-1', 'draft.json', JSON.stringify({ prompt: 'Opus for all.' }));

    // Act
    const done = await subject.service.job('run-1');

    // Assert
    should(done?.suggestion?.before).equal(IN_EFFECT);
  });

  it('should say the writer, not the clean-up, ended without a prompt', async () => {
    // Arrange
    const subject = build();
    await subject.service.start({ mode: 'generate' });
    subject.statuses.set('cleanup-1', 'failed');

    // Act
    const failed = await subject.service.job('run-1');

    // Assert
    should(failed?.job.message).equal('The writer failed without writing a prompt.');
  });
});

describe('CleanUpService.status', () => {
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
    const empty = build({ runtimes: [] });
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
    should(await empty.service.status()).deepEqual({
      available: false,
      runtimes: [],
      reason: 'There is no agent runtime on this machine to clean up with.',
    });
  });
});
