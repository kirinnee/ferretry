/**
 * THE WORKER HOST over real storage and a scripted thread: it applies what a session's worker found, in
 * order and through the one writer; it asks the worker when a read needs an answer now and works it out
 * itself when the worker cannot; and its 2 s tick only hands sessions to workers and observes the rest.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  countWorkerChildren,
  type DaemonStorage,
  DaemonStorageFactory,
  InlineObserverHost,
  KeyedSerialExecutor,
  type ObserverWorker,
  RuntimeEnvironment,
  SessionObservationApplier,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
  WorkerObserverHost,
  WorkerSupervisor,
} from '../../../../src/adapters/index.ts';
import {
  type FromSessionWorker,
  type ObserverPatch,
  parseSessionId,
  projectStructuredQuestion,
  type SessionBinding,
  type SessionId,
  SessionObserver,
  type ToSessionWorker,
  type TranscriptEvent,
  type TranscriptStamp,
  TURN_WATCH_INTERVAL_MS,
  type TurnPaneEvidence,
  type WorkerAsk,
  type WorkerChild,
} from '../../../../src/lib/index.ts';

const NOW = '2026-10-22T08:00:00.000Z';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const A = parseSessionId('hosted-a');
const B = parseSessionId('inline-b');
const BUSY: TurnPaneEvidence = { working: true, atPrompt: false, permission: false };
const question: TranscriptEvent = {
  kind: 'tool-call',
  harness: 'claude',
  role: 'assistant',
  timestamp: NOW,
  call: {
    id: 'tool-1',
    name: 'AskUserQuestion',
    input: {},
    questions: [{ question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }], multiple: false }],
  },
};

async function openStorage(): Promise<DaemonStorage> {
  const home = await mkdtemp(join(tmpdir(), 'fy-worker-host-'));
  const opened = await new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  ).open();
  cleanups.push(async () => {
    await opened.storage.close();
    await rm(home, { recursive: true, force: true });
  });
  return opened.storage;
}

type Ask = Extract<ToSessionWorker, { kind: 'request' }>;

/** A thread that answers its probe at once and every request the way the test scripts. */
class AnsweringWorker implements ObserverWorker {
  onmessage: ((event: MessageEvent<FromSessionWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: ToSessionWorker[] = [];
  terminated = false;

  constructor(private readonly answer: (request: Ask) => FromSessionWorker | undefined) {}

  postMessage(message: ToSessionWorker): void {
    this.sent.push(message);
    queueMicrotask(() => {
      if ('probe' in message) this.emit({ probe: true });
      else if (message.kind === 'stop') this.emit({ kind: 'stopped' });
      else if (message.kind === 'request') {
        const answer = this.answer(message);
        if (answer !== undefined) this.emit(answer);
      }
    });
  }

  emit(message: FromSessionWorker): void {
    this.onmessage?.({ data: message } as MessageEvent<FromSessionWorker>);
  }

  terminate(): void {
    this.terminated = true;
  }

  kinds(): string[] {
    return this.sent.map(message => ('kind' in message ? message.kind : 'probe'));
  }
}

const answered = (request: Ask, value: unknown): FromSessionWorker => ({
  kind: 'answered',
  session: request.session,
  generation: request.generation,
  request: request.request,
  value,
  metrics: { children: [] },
});

async function rig(
  options: {
    readonly answer?: (request: Ask, worker: AnsweringWorker) => FromSessionWorker | undefined;
    readonly binding?: (id: string) => SessionBinding | undefined;
    readonly answerBusy?: boolean;
    readonly barrierMs?: number;
    readonly stat?: (file: string) => TranscriptStamp | undefined;
    /** Holds every reconcile the host runs as an activity until it resolves. */
    readonly activity?: () => Promise<void>;
  } = {},
) {
  const storage = await openStorage();
  const ledgerRows = new Map<string, never>();
  const answers = { all: async () => ledgerRows, append: async () => undefined };
  const applier = new SessionObservationApplier(storage, answers, new KeyedSerialExecutor());
  const reads: string[] = [];
  const serial = new KeyedSerialExecutor();
  const answerSerial = {
    runIfIdle: async <T>(key: string, work: () => Promise<T>) =>
      options.answerBusy === true ? undefined : await serial.runIfIdle(key, work),
  };
  const inline = new InlineObserverHost(
    {
      storage,
      questionRoster: () => storage.listSessions().map(session => session.id),
      tail: { tail: async () => ({ kind: 'read', events: [question] }) },
      pane: async id => {
        reads.push(`pane ${id}`);
        return BUSY;
      },
      answers,
      answerSerial,
      applier,
      liveness: {
        screen: async id => {
          reads.push(`screen ${id}`);
          return 'inline screen';
        },
        transcript: async () => 'lines',
        processes: async () => ({ kind: 'observed', processes: [] }),
      },
      clock: { now: () => NOW },
      yieldToLoop: async () => undefined,
      paneState: async id => {
        reads.push(`paneState ${id}`);
        return undefined;
      },
      sendEvidence: {
        read: async id => {
          reads.push(`evidence ${id}`);
          return { readable: false, inputs: [] };
        },
      },
      every: (intervalMs, tick) => {
        const timer = setInterval(tick, intervalMs);
        return () => clearInterval(timer);
      },
    },
    new SessionObserver(text => `digest(${text})`),
  );
  const workers: AnsweringWorker[] = [];
  const scheduled: number[] = [];
  const activities = { count: 0 };
  const watched: string[] = [];
  const closedWatches: string[] = [];
  let subject: WorkerObserverHost | undefined;
  const supervisor = new WorkerSupervisor(
    {
      spawn: () => {
        const worker: AnsweringWorker = new AnsweringWorker(request => options.answer?.(request, worker));
        workers.push(worker);
        return worker;
      },
      nowMs: () => Date.now(),
      schedule: (delayMs, run) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      },
      notice: () => undefined,
      report: () => undefined,
      observed: (session, patches, transcript) => subject?.observed(session, patches, transcript),
      liveness: (session, liveness) => subject?.livenessChanged(session, liveness),
      changed: () => subject?.poke(),
      exited: () => undefined,
    },
    { cap: 8, requestTimeoutMs: 1_000, drainMs: 10, startConcurrency: 2 },
  );
  subject = new WorkerObserverHost({
    inline,
    supervisor,
    binding: async id =>
      options.binding === undefined
        ? {
            tmux: { executable: '/usr/bin/tmux', socket: '/tmp/s', target: `fy-${id}` },
            transcript: { file: `/t/${id}.jsonl`, harness: 'claude' },
          }
        : options.binding(id),
    applier,
    answerSerial,
    answers,
    files: {
      subscribe: (path, listener) => {
        watched.push(path);
        queueMicrotask(() => listener(path));
        return { close: () => closedWatches.push(path) };
      },
    },
    observer: new SessionObserver(text => `digest(${text})`),
    liveness: {
      redact: async text => text.replaceAll('secret', '[redacted]'),
      processes: async () =>
        ({ kind: 'observed', processes: [{ pid: 1, argv: 'bash -c sleep 600', verdict: 'unknown' }] }) as never,
    },
    clock: { now: () => NOW },
    barrierMs: options.barrierMs ?? 1_000,
    stat: async file => options.stat?.(file),
    schedule: (delayMs, run) => {
      scheduled.push(delayMs);
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
    activity: async work => {
      activities.count += 1;
      await options.activity?.();
      return await work();
    },
  });
  const host = subject;
  cleanups.push(async () => await host.close());
  /** One tick, then long enough for the thread to answer its probe, then another: hosted from here on. */
  const hostAll = async () => {
    await host.turns.run();
    await Bun.sleep(5);
    await host.turns.run();
    await Bun.sleep(5);
  };
  return {
    storage,
    subject: host,
    workers,
    reads,
    watched,
    closedWatches,
    hostAll,
    supervisor,
    ledgerRows,
    scheduled,
    activities,
  };
}

const stateOf = async (storage: DaemonStorage, id: SessionId) =>
  (await storage.readState(id)) as Record<string, unknown>;

describe('WorkerObserverHost — what a worker found', () => {
  it('should apply a session’s patches in the order they came, question before turn', async () => {
    // Arrange
    const { storage, subject } = await rig();
    await storage.writeState(A, { id: A, status: 'running', turn: 1 });
    const patches: readonly ObserverPatch[] = [
      {
        kind: 'question',
        projection: projectStructuredQuestion([question]),
        records: [],
        settlements: [],
        runtime: {},
        writes: true,
      },
      { kind: 'turn', change: { from: undefined, to: 'needs-input' } },
    ];

    // Act — the turn's compare-and-set would refuse if it ran first: the question flips the status.
    subject.observed(A, patches);
    subject.observed(A, []);
    for (let wait = 0; wait < 100 && (await stateOf(storage, A)).turnState === undefined; wait += 1)
      await Bun.sleep(10);

    // Assert
    const state = await stateOf(storage, A);
    should(state.status).equal('awaiting_question');
    should(state.turnState).equal('needs-input');
  });

  it('should never write a question patch while an answer drive holds the session, and survive a refused write', async () => {
    // Arrange
    const { storage, subject } = await rig({ answerBusy: true });
    await storage.writeState(A, { id: A, status: 'running', turn: 1 });

    // Act
    subject.observed(A, [
      {
        kind: 'question',
        projection: projectStructuredQuestion([question]),
        records: [],
        settlements: [],
        runtime: {},
        writes: true,
      },
    ]);
    subject.observed(B, [{ kind: 'turn', change: { from: undefined, to: 'working' } }]);
    await Bun.sleep(10);

    // Assert — A untouched; B has no document, and the refusal stays in its own patch.
    should(await stateOf(storage, A)).deepEqual({ id: A, status: 'running', turn: 1 });
  });
});

describe('WorkerObserverHost — the tick', () => {
  it('should hand running sessions to workers, push their receipts and watch their transcripts, and look at the rest here', async () => {
    // Arrange — B has no pane a worker could attach to.
    const { storage, workers, reads, watched, closedWatches, hostAll, supervisor, subject } = await rig({
      binding: id =>
        id === B
          ? undefined
          : {
              tmux: { executable: '/usr/bin/tmux', socket: '/tmp/s', target: 'fy-a' },
              transcript: { file: '/t/a.jsonl', harness: 'claude' },
            },
    });
    await storage.writeState(A, { id: A, status: 'running', turn: 1 });
    await storage.writeState(B, { id: B, status: 'running', turn: 1 });

    // Act
    await hostAll();
    reads.length = 0;
    await subject.turns.run();
    await storage.updateState(A, raw => ({ ...(raw as Record<string, unknown>), status: 'stopped' }));
    await subject.turns.run();

    // Assert
    should(workers.length).equal(1);
    should(reads).deepEqual([`pane ${B}`, `pane ${B}`]);
    should(watched).deepEqual(['/t/a.jsonl']);
    should(closedWatches).deepEqual(['/t/a.jsonl']);
    should(supervisor.hosts(A)).be.false();
    const kinds = workers[0]?.kinds() ?? [];
    should(kinds.slice(0, 3)).deepEqual(['probe', 'attach', 'answers']);
    should(kinds).containEql('file');
    should(kinds).containEql('facts');
  });

  it('should rewatch a moved transcript, and push receipts when the ledger grows', async () => {
    // Arrange
    let file = '/t/first.jsonl';
    const { storage, workers, watched, closedWatches, hostAll, subject } = await rig({
      binding: () => ({
        tmux: { executable: '/usr/bin/tmux', socket: '/tmp/s', target: 'fy-a' },
        transcript: { file, harness: 'claude' },
      }),
    });
    await storage.writeState(A, { id: A, status: 'running', turn: 1 });
    await hostAll();

    // Act
    file = '/t/second.jsonl';
    await subject.turns.run();
    await subject.answersChanged(A);
    await subject.answersChanged(B);

    // Assert
    should(watched).deepEqual(['/t/first.jsonl', '/t/second.jsonl']);
    should(closedWatches).deepEqual(['/t/first.jsonl']);
    should(workers[0]?.kinds().filter(kind => kind === 'answers').length).equal(2);
  });

  it('should never overlap itself, and answer nothing for a tick whose roster could not be read', async () => {
    // Arrange
    const { storage, subject } = await rig();
    const listSessions = storage.listSessions.bind(storage);
    let broken = false;
    storage.listSessions = () => {
      if (broken) throw new Error('the index is locked');
      return listSessions();
    };

    // Act
    const [one, two] = await Promise.all([subject.turns.run(), subject.turns.run()]);
    broken = true;
    const failed = await subject.turns.run();

    // Assert
    should(one).not.be.undefined();
    should(two).be.undefined();
    should(failed).be.undefined();
    should(subject.turns.intervalMs).equal(2_000);
  });
});

describe('WorkerObserverHost — reads that need an answer now', () => {
  it('should ask a hosted session’s worker, and use what it answered', async () => {
    // Arrange
    const { storage, subject, hostAll, reads } = await rig({
      answer: request => {
        const ask: WorkerAsk = request.ask;
        if (ask.kind === 'pane')
          return answered(request, { visible: 'worker frame', alive: true, promptReady: false, history: '' });
        if (ask.kind === 'liveness') return answered(request, { screen: 'a secret screen', transcript: 'fingerprint' });
        if (ask.kind === 'send-evidence') return answered(request, { readable: true, inputs: [] });
        return answered(request, null);
      },
    });
    await storage.writeState(A, { id: A, status: 'running', turn: 1, turnState: 'working' });
    await hostAll();
    reads.length = 0;

    // Act
    await subject.project(A);
    const pane = await subject.pane(A);
    const sample = await subject.liveness({
      id: A,
      status: 'running',
      turn: 1,
      mode: 'auto',
      waiting: false,
      tmuxSession: 'fy-a',
    });
    const evidence = await subject.sendEvidence(A, NOW);
    const failures = await subject.questions();

    // Assert — nothing was read on this thread, and the screen was masked here before it was digested.
    should(reads).deepEqual([]);
    should(pane?.visible).equal('worker frame');
    should(sample).deepEqual({
      pane: 'a [redacted] screen',
      paneHash: 'digest(a [redacted] screen)',
      transcriptHash: 'digest(fingerprint)',
      subprocessAlive: true,
      subprocessKey: 'pid:1',
    });
    should(evidence).deepEqual({ readable: true, inputs: [] });
    should(failures.size).equal(0);
    should(await subject.midTurn()).equal(1);
  });

  it('should work it out on this thread when the worker cannot answer, or answers too late', async () => {
    // Arrange — every request fails, except a barrier the worker never answers.
    const { storage, subject, hostAll, reads } = await rig({
      barrierMs: 20,
      answer: request =>
        request.ask.kind === 'observe'
          ? undefined
          : {
              ...(answered(request, undefined) as Extract<FromSessionWorker, { kind: 'answered' }>),
              value: undefined,
              failure: 'gone',
            },
    });
    await storage.writeState(A, { id: A, status: 'running', turn: 1 });
    await hostAll();
    reads.length = 0;

    // Act
    await subject.project(A);
    await subject.pane(A);
    await subject.liveness({ id: A, status: 'running', turn: 1, mode: 'auto', waiting: false });
    await subject.sendEvidence(A, NOW);

    // Assert
    should(reads).deepEqual([`paneState ${A}`, `screen ${A}`, `evidence ${A}`]);
    should((await stateOf(storage, A)).status).equal('awaiting_question');
  });

  it('should treat a worker’s answer of no pane as none, and read a session no worker hosts here', async () => {
    // Arrange
    const { storage, subject, hostAll, reads } = await rig({ answer: request => answered(request, null) });
    await storage.writeState(A, { id: A, status: 'running', turn: 1 });
    await hostAll();
    reads.length = 0;

    // Act
    const pane = await subject.pane(A);
    await subject.pane(B);
    await subject.sendEvidence(B, NOW);
    await subject.liveness({ id: B, status: 'running', turn: 1, mode: 'auto', waiting: false });

    // Assert
    should(pane).be.undefined();
    should(reads).deepEqual([`paneState ${B}`, `evidence ${B}`, `screen ${B}`]);
  });
});

describe('countWorkerChildren', () => {
  it('should count every child by program and subcommand, never its text, until drained', async () => {
    // Arrange
    let now = 0;
    const host = {
      spawn: ((..._args: unknown[]) => ({ exited: Promise.resolve(0) })) as unknown as typeof Bun.spawn,
      spawnSync: ((..._args: unknown[]) => ({ exitCode: 0 })) as unknown as typeof Bun.spawnSync,
    };
    const drain = countWorkerChildren(host, () => now);

    // Act
    host.spawn(['tmux', 'capture-pane', '-p', 'secret text']);
    host.spawn({ cmd: ['ps', '-o', 'pid'] } as never);
    now = 5;
    host.spawnSync(['readlink', '/proc/1/cwd']);
    host.spawnSync({} as never);
    await Promise.resolve();
    const first: readonly WorkerChild[] = drain();
    const second = drain();

    // Assert
    should(first.map(child => child.argv)).deepEqual([
      ['readlink', '/proc/1/cwd'],
      [],
      ['tmux', 'capture-pane', '-p'],
      ['ps', '-o', 'pid'],
    ]);
    should(second).deepEqual([]);
  });
});

const until = async (done: () => boolean): Promise<void> => {
  for (let wait = 0; wait < 200 && !done(); wait += 1) await Bun.sleep(5);
};

describe('WorkerObserverHost — armed, with no tick', () => {
  it('should reconcile nothing before it is armed, then at once and after every change, as the turn watcher', async () => {
    // Arrange
    const { storage, subject, supervisor, scheduled, activities } = await rig();
    await storage.writeState(A, { id: A, status: 'running', turn: 1 });
    subject.poke(0);
    const beforeArm = [...scheduled];

    // Act — the worker becoming ready is itself a change: hosting is reconciled again, and A attached.
    subject.arm();
    await until(() => activities.count >= 2);

    // Assert
    should(beforeArm).deepEqual([]);
    should(scheduled[0]).equal(0);
    should(scheduled).containEql(250);
    should(supervisor.attached(A)).be.true();
    should(activities.count).be.aboveOrEqual(2);
  });

  it('should reconcile on a 30 s backstop while every session has a worker', async () => {
    // Arrange
    const { storage, subject, scheduled } = await rig();
    await storage.writeState(A, { id: A, status: 'running', turn: 1 });

    // Act
    subject.arm();
    await until(() => scheduled.includes(30_000));

    // Assert
    should(scheduled).containEql(30_000);
    should(scheduled).not.containEql(TURN_WATCH_INTERVAL_MS);
  });

  it('should look here again in 2 s only while some session is left to this thread', async () => {
    // Arrange — B has no pane a worker could attach to.
    const { storage, subject, scheduled, activities } = await rig({ binding: () => undefined });
    await storage.writeState(B, { id: B, status: 'running', turn: 1 });

    // Act
    subject.arm();
    await until(() => scheduled.includes(TURN_WATCH_INTERVAL_MS));

    // Assert
    should(scheduled).containEql(TURN_WATCH_INTERVAL_MS);
    should(activities.count).be.aboveOrEqual(1);
  });

  it('should run a reconcile asked for during one once after it, never beside it', async () => {
    // Arrange — the first reconcile is held until the second is asked for.
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    let first = true;
    const { subject, scheduled, activities } = await rig({
      activity: async () => {
        if (!first) return;
        first = false;
        await held;
      },
    });
    subject.arm();
    await until(() => activities.count === 1);

    // Act
    subject.poke(0);
    await Bun.sleep(10);
    const during = activities.count;
    release();
    await until(() => activities.count === 2);

    // Assert
    should(during).equal(1);
    should(activities.count).equal(2);
    should(scheduled.slice(0, 3)).deepEqual([0, 0, 250]);
  });

  it('should answer a read barrier without asking once the worker has read every byte of the transcript', async () => {
    // Arrange
    let size = 10;
    const { storage, subject, hostAll, workers } = await rig({
      answer: request => answered(request, null),
      stat: () => ({ size, mtimeMs: 5 }),
    });
    await storage.writeState(A, { id: A, status: 'running', turn: 1 });
    await hostAll();
    subject.observed(A, [], { size: 10, mtimeMs: 5 });
    const asked = () =>
      workers.flatMap(worker => worker.sent).filter(message => 'kind' in message && message.kind === 'request');

    // Act
    await subject.project(A);
    const unchanged = asked().length;
    size = 11;
    await subject.project(A);

    // Assert
    should(unchanged).equal(0);
    should(asked().length).equal(1);
  });

  it('should take the Warden’s look from what the worker pushed, asking nothing', async () => {
    // Arrange
    const { storage, subject, hostAll, workers, reads } = await rig({ answer: request => answered(request, null) });
    await storage.writeState(A, { id: A, status: 'running', turn: 1 });
    await hostAll();
    reads.length = 0;

    // Act
    subject.livenessChanged(A, { screen: 'a secret screen', transcript: 'fingerprint' });
    const sample = await subject.liveness({ id: A, status: 'running', turn: 1, mode: 'auto', waiting: false });

    // Assert
    should(workers.flatMap(worker => worker.kinds())).not.containEql('request');
    should(reads).deepEqual([]);
    should(sample).deepEqual({
      pane: 'a [redacted] screen',
      paneHash: 'digest(a [redacted] screen)',
      transcriptHash: 'digest(fingerprint)',
    });
  });
});
