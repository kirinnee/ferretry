/**
 * THE WORKER HOST'S TURN TICK over real storage and a scripted thread: a hosted session is looked at by
 * its worker and written here; everything else — and any look the worker could not answer — is looked
 * at on this thread, so nothing is ever left unobserved.
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
  parseSessionId,
  type SessionBinding,
  SessionObserver,
  type ToSessionWorker,
  type TurnPaneEvidence,
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

/** A thread that answers its probe at once and every look the way the test scripts. */
class AnsweringWorker implements ObserverWorker {
  onmessage: ((event: MessageEvent<FromSessionWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: ToSessionWorker[] = [];
  terminated = false;

  constructor(private readonly answer: (look: Extract<ToSessionWorker, { kind: 'look' }>) => FromSessionWorker) {}

  postMessage(message: ToSessionWorker): void {
    this.sent.push(message);
    queueMicrotask(() => {
      if ('probe' in message) this.onmessage?.({ data: { probe: true } } as MessageEvent<FromSessionWorker>);
      else if (message.kind === 'look')
        this.onmessage?.({ data: this.answer(message) } as MessageEvent<FromSessionWorker>);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

async function rig(options: {
  readonly answer: (look: Extract<ToSessionWorker, { kind: 'look' }>) => FromSessionWorker;
  readonly binding?: (id: string) => SessionBinding | undefined;
  readonly applierFails?: boolean;
}) {
  const storage = await openStorage();
  const answers = { all: async () => new Map(), append: async () => undefined };
  const applier = new SessionObservationApplier(storage, answers, new KeyedSerialExecutor());
  const inlinePanes: string[] = [];
  const inline = new InlineObserverHost(
    {
      storage,
      questionRoster: () => storage.listSessions().map(session => session.id),
      tail: { tail: async () => ({ kind: 'unresolved' }) },
      pane: async id => {
        inlinePanes.push(id);
        return BUSY;
      },
      answers,
      answerSerial: new KeyedSerialExecutor(),
      applier,
      liveness: {
        screen: async () => 'screen',
        transcript: async () => 'lines',
        processes: async () => ({ kind: 'observed', processes: [] }),
      },
      clock: { now: () => NOW },
      yieldToLoop: async () => undefined,
    },
    new SessionObserver(text => `digest(${text})`),
  );
  const workers: AnsweringWorker[] = [];
  const supervisor = new WorkerSupervisor(
    {
      spawn: () => {
        const worker = new AnsweringWorker(options.answer);
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
    },
    { cap: 8, lookTimeoutMs: 1_000, drainMs: 10, startConcurrency: 2 },
  );
  const subject = new WorkerObserverHost({
    inline,
    supervisor,
    binding: async id =>
      options.binding === undefined
        ? { tmux: { executable: '/usr/bin/tmux', socket: '/tmp/s', target: `fy-${id}` } }
        : options.binding(id),
    applier: options.applierFails
      ? {
          apply: async () => {
            throw new Error('the document is damaged');
          },
        }
      : applier,
    clock: { now: () => NOW },
  });
  cleanups.push(async () => subject.close());
  return { storage, subject, workers, inlinePanes };
}

const looked = (
  look: Extract<ToSessionWorker, { kind: 'look' }>,
  fields: Partial<Extract<FromSessionWorker, { kind: 'looked' }>> = {},
): FromSessionWorker => ({
  kind: 'looked',
  session: look.session,
  generation: look.generation,
  request: look.request,
  lookMs: 1,
  metrics: { children: [] },
  ...fields,
});

const turnStateOf = async (storage: DaemonStorage, id: string) =>
  ((await storage.readState(parseSessionId(id))) as Record<string, unknown>).turnState;

describe('WorkerObserverHost', () => {
  it('should write what a hosted session’s worker answers, and look at the rest on this thread', async () => {
    // Arrange — B has no pane a worker could attach to, so it stays inline.
    const { storage, subject, workers, inlinePanes } = await rig({
      answer: look => looked(look, { patch: { kind: 'turn', change: { from: undefined, to: 'needs-input' } } }),
      binding: id =>
        id === B ? undefined : { tmux: { executable: '/usr/bin/tmux', socket: '/tmp/s', target: 'fy-a' } },
    });
    await storage.writeState(A, { id: A, status: 'running', turn: 1 });
    await storage.writeState(B, { id: B, status: 'running', turn: 1 });

    // Act — the first tick starts the worker; once it answered its probe, the next is its.
    const first = await subject.turns.run();
    await Bun.sleep(5);
    inlinePanes.length = 0;
    await storage.updateState(A, raw => {
      const { turnState: _cleared, ...rest } = raw as Record<string, unknown>;
      return rest as typeof raw;
    });
    const second = await subject.turns.run();

    // Assert
    should([...(first?.changed.keys() ?? [])].sort()).deepEqual([A, B].sort());
    should(workers.length).equal(1);
    should(inlinePanes).deepEqual([B]);
    should(second?.changed.get(A)).deepEqual({ from: undefined, to: 'needs-input' });
    should(await turnStateOf(storage, A)).equal('needs-input');
    should(await turnStateOf(storage, B)).equal('working');
    // The worker is told what the writes did, so it decides from what the document says now.
    should(workers[0]?.sent.some(message => 'kind' in message && message.kind === 'facts')).be.true();
  });

  it('should look once on this thread when the worker could not, and report a write that failed', async () => {
    // Arrange
    const failing = await rig({ answer: look => looked(look, { failure: 'the pane is gone' }) });
    await failing.storage.writeState(A, { id: A, status: 'running', turn: 1 });
    await failing.subject.turns.run();
    await Bun.sleep(5);
    const damaged = await rig({
      answer: look => looked(look, { patch: { kind: 'turn', change: { from: undefined, to: 'working' } } }),
      applierFails: true,
    });
    await damaged.storage.writeState(A, { id: A, status: 'running', turn: 1 });
    await damaged.subject.turns.run();
    await Bun.sleep(5);

    // Act
    failing.inlinePanes.length = 0;
    const fellBack = await failing.subject.turns.run();
    const refused = await damaged.subject.turns.run();

    // Assert
    should(failing.inlinePanes).deepEqual([A]);
    should(fellBack?.failures.size).equal(0);
    should(refused?.failures.get(A)).equal('the document is damaged');
  });

  it('should never overlap itself, and hand every other part to the inline host', async () => {
    // Arrange
    const { storage, subject } = await rig({ answer: look => looked(look) });
    await storage.writeState(A, { id: A, status: 'running', turn: 1, turnState: 'working' });

    // Act
    const [one, two] = await Promise.all([subject.turns.run(), subject.turns.run()]);
    const sample = await subject.liveness({ id: A, status: 'running', turn: 1, mode: 'auto', waiting: false });
    const failures = await subject.questions();
    await subject.project(A);

    // Assert
    should(two).be.undefined();
    should(one).not.be.undefined();
    should(subject.turns.intervalMs).equal(2_000);
    should(sample.paneHash).equal('digest(screen)');
    should(failures.size).equal(0);
    should(await subject.midTurn()).equal(1);
  });

  it('should answer a tick whose roster could not be read with nothing, and still look next time', async () => {
    // Arrange
    const { storage, subject } = await rig({ answer: look => looked(look) });
    const listSessions = storage.listSessions.bind(storage);
    let broken = true;
    storage.listSessions = () => {
      if (broken) throw new Error('the index is locked');
      return listSessions();
    };

    // Act
    const failed = await subject.turns.run();
    broken = false;
    const next = await subject.turns.run();

    // Assert
    should(failed).be.undefined();
    should(next).not.be.undefined();
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
