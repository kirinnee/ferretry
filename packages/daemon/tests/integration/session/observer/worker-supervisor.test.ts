/**
 * THE SESSION WORKERS' SUPERVISOR over scripted threads that answer, stall and crash on cue.
 *
 * Which thread hosts which session, when a session counts as hosted, what a crash or a stuck look
 * costs, and that nothing an ended generation says is believed.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type ObserverWorker,
  type WantedSession,
  type WorkerLookReport,
  WorkerSupervisor,
} from '../../../../src/adapters/index.ts';
import {
  type FromSessionWorker,
  type ObserverPatch,
  parseSessionId,
  type SessionBinding,
  type SessionId,
  type ToSessionWorker,
  type WorkerLiveness,
} from '../../../../src/lib/index.ts';

/** A thread that records what it is sent and answers only when the test says so. */
class ScriptedWorker implements ObserverWorker {
  onmessage: ((event: MessageEvent<FromSessionWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: ToSessionWorker[] = [];
  terminated = false;
  private closeListener: (() => void) | undefined;

  postMessage(message: ToSessionWorker): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(_type: 'close', listener: () => void): void {
    this.closeListener = listener;
  }

  answer(message: FromSessionWorker): void {
    this.onmessage?.({ data: message } as MessageEvent<FromSessionWorker>);
  }

  ready(): void {
    this.answer({ probe: true });
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  exit(): void {
    this.closeListener?.();
  }

  /** The last look this thread was asked for. */
  lastLook(): Extract<ToSessionWorker, { kind: 'request' }> {
    const look = this.sent
      .filter(
        (message): message is Extract<ToSessionWorker, { kind: 'request' }> =>
          'kind' in message && message.kind === 'request',
      )
      .at(-1);
    if (look === undefined) throw new Error('no look was asked for');
    return look;
  }

  kinds(): string[] {
    return this.sent.map(message => ('kind' in message ? message.kind : 'probe'));
  }
}

interface Rig {
  readonly subject: WorkerSupervisor;
  readonly workers: ScriptedWorker[];
  readonly notices: string[];
  readonly reports: WorkerLookReport[];
  readonly observed: [SessionId, readonly ObserverPatch[]][];
  readonly exited: SessionId[];
  readonly livenesses: [SessionId, WorkerLiveness][];
  /** How many times the supervisor said which sessions are hosted may have changed. */
  readonly changes: { count: number };
  /** Runs every timer due by `ms` from the start. */
  readonly advance: (ms: number) => void;
}

function rig(cap = 8, overrides: { lookTimeoutMs?: number; startConcurrency?: number } = {}): Rig {
  const workers: ScriptedWorker[] = [];
  const notices: string[] = [];
  const reports: WorkerLookReport[] = [];
  const observed: [SessionId, readonly ObserverPatch[]][] = [];
  const exited: SessionId[] = [];
  const livenesses: [SessionId, WorkerLiveness][] = [];
  const changes = { count: 0 };
  let now = 1_000_000;
  let timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const subject = new WorkerSupervisor(
    {
      spawn: () => {
        const worker = new ScriptedWorker();
        workers.push(worker);
        return worker;
      },
      nowMs: () => now,
      schedule: (delayMs, run) => {
        const timer = { at: now + delayMs, run, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      notice: (_session, message) => notices.push(message),
      report: report => reports.push(report),
      observed: (session, patches) => observed.push([session, patches]),
      liveness: (session, liveness) => livenesses.push([session, liveness]),
      changed: () => {
        changes.count += 1;
      },
      exited: session => exited.push(session),
    },
    {
      cap,
      requestTimeoutMs: overrides.lookTimeoutMs ?? 10_000,
      drainMs: 2_000,
      startConcurrency: overrides.startConcurrency ?? 2,
    },
  );
  return {
    subject,
    workers,
    notices,
    reports,
    observed,
    exited,
    livenesses,
    changes,
    advance: ms => {
      now += ms;
      const due = timers.filter(timer => !timer.cancelled && timer.at <= now);
      timers = timers.filter(timer => !due.includes(timer));
      for (const timer of due) timer.run();
    },
  };
}

const binding = (target: string): SessionBinding => ({
  tmux: { executable: '/usr/bin/tmux', socket: '/tmp/fy.sock', target },
});
const wanted = (id: SessionId, target = `fy-${id}`): WantedSession => ({
  id,
  facts: { status: 'running', turn: 1 },
  binding: binding(target),
});
const [A, B, C] = ['a', 'b', 'c'].map(name => parseSessionId(name)) as [SessionId, SessionId, SessionId];

describe('WorkerSupervisor', () => {
  it('should hand on what a thread found unasked and a pane that died, for the current generation only', () => {
    // Arrange
    const { subject, workers, reports, observed, exited } = rig();
    const attached = subject.reconcile([wanted(A)]);
    workers[0]?.ready();
    const patches: readonly ObserverPatch[] = [{ kind: 'turn', change: { from: undefined, to: 'working' } }];

    // Act
    workers[0]?.answer({ kind: 'observed', session: A, generation: 1, patches, lookMs: 4, metrics: { children: [] } });
    workers[0]?.answer({ kind: 'observed', session: A, generation: 9, patches, lookMs: 1, metrics: { children: [] } });
    workers[0]?.answer({ kind: 'exited', session: A, generation: 1 });
    workers[0]?.answer({ kind: 'exited', session: B, generation: 1 });

    // Assert — the stale generation and the unknown session are counted for the profile, nothing more.
    should(attached).deepEqual([A]);
    should(observed).deepEqual([[A, patches]]);
    should(exited).deepEqual([A]);
    should(reports.map(report => [report.kind, report.lookMs])).deepEqual([
      ['look', 4],
      ['look', 1],
    ]);
  });

  it('should hand on a pushed liveness look for the current generation only', () => {
    // Arrange
    const { subject, workers, livenesses } = rig();
    subject.reconcile([wanted(A)]);
    workers[0]?.ready();

    // Act
    workers[0]?.answer({ kind: 'liveness', session: A, generation: 1, liveness: { screen: 'now' } });
    workers[0]?.answer({ kind: 'liveness', session: A, generation: 9, liveness: { screen: 'stale' } });

    // Assert
    should(livenesses).deepEqual([[A, { screen: 'now' }]]);
  });

  it('should say hosting may have changed when a thread is ready, when it crashed, and when its back-off ran out', () => {
    // Arrange
    const { subject, workers, changes, advance } = rig();
    subject.reconcile([wanted(A)]);

    // Act
    workers[0]?.ready();
    const ready = changes.count;
    workers[0]?.fail('segfault in a parser');
    const crashed = changes.count;
    advance(1_000);

    // Assert
    should([ready, crashed, changes.count]).deepEqual([1, 2, 3]);
  });

  it('should tell a hosted session’s thread its transcript changed and its receipts, and nobody else', () => {
    // Arrange
    const { subject, workers } = rig();
    subject.reconcile([wanted(A)]);
    workers[0]?.ready();

    // Act
    subject.file(A);
    subject.file(B);
    subject.answers(A, []);
    subject.answers(B, []);

    // Assert
    should(workers[0]?.kinds()).deepEqual(['probe', 'attach', 'file', 'answers']);
  });

  it('should show the pool as status and profiles do: its size, its threads and the sessions on each', () => {
    // Arrange
    const { subject, workers } = rig(2);
    const empty = subject.pool;

    // Act
    subject.reconcile([wanted(A), wanted(B)]);
    for (const worker of workers) worker.ready();
    subject.reconcile([wanted(A), wanted(B), wanted(C)]);

    // Assert
    should(empty).deepEqual({ max: 2, threads: 0, sessionsPerThread: [] });
    should(subject.pool).deepEqual({ max: 2, threads: 2, sessionsPerThread: [2, 1] });
  });

  it('should start one thread per session, probe it, and host only once it answered', async () => {
    // Arrange
    const { subject, workers } = rig();

    // Act
    subject.reconcile([wanted(A)]);
    const beforeReady = subject.hosts(A);
    workers[0]?.ready();

    // Assert
    should(beforeReady).be.false();
    should(subject.hosts(A)).be.true();
    should(workers[0]?.kinds()).deepEqual(['probe', 'attach']);
    should(subject.threadCount).equal(1);
  });

  it('should tell a thread nothing but its probe until it answers, and one closed while it loads nothing', () => {
    // Arrange
    const { subject, workers } = rig();

    // Act — the first thread is handed a session and its facts while it loads, then answers; the second is
    // handed one and closed before it loads, and answers only after.
    subject.reconcile([wanted(A)]);
    subject.facts(A, { status: 'running', turn: 2 });
    const whileLoading = workers[0]?.kinds();
    workers[0]?.ready();
    subject.reconcile([wanted(A), wanted(B)]);
    subject.close();
    workers[1]?.ready();

    // Assert — held, then sent in the order handed; and a thread ended first never learns of its session.
    should(whileLoading).deepEqual(['probe']);
    should(workers[0]?.kinds()).deepEqual(['probe', 'attach', 'facts']);
    should(workers[1]?.kinds()).deepEqual(['probe']);
    should(workers[1]?.terminated).be.true();
  });

  it('should start at most two threads at once and the rest on later passes', () => {
    // Arrange
    const { subject, workers } = rig();

    // Act
    subject.reconcile([wanted(A), wanted(B), wanted(C)]);
    const firstPass = workers.length;
    for (const worker of workers) worker.ready();
    subject.reconcile([wanted(A), wanted(B), wanted(C)]);

    // Assert
    should(firstPass).equal(2);
    should(workers.length).equal(3);
  });

  it('should pool past the cap, and answer a request with what its thread sent', async () => {
    // Arrange
    const { subject, workers, reports } = rig(1);
    subject.reconcile([wanted(A), wanted(B)]);
    workers[0]?.ready();
    subject.reconcile([wanted(A), wanted(B)]);

    // Act
    const looking = subject.request(B, { kind: 'pane' });
    const look = workers[0]?.lastLook();
    workers[0]?.answer({
      kind: 'answered',
      session: B,
      generation: look?.generation ?? 0,
      request: look?.request ?? 0,
      value: { visible: 'frame' },
      metrics: { children: [{ argv: ['tmux', 'capture-pane'], wallMs: 2 }] },
    });

    // Assert
    should(workers.length).equal(1);
    should(await looking).deepEqual({ visible: 'frame' });
    should(reports).deepEqual([
      { kind: 'answer', lookMs: 0, children: [{ argv: ['tmux', 'capture-pane'], wallMs: 2 }] },
    ]);
    should(subject.inFlight).equal(0);
  });

  it('should refuse a look its thread failed, and one for a session nobody hosts', async () => {
    // Arrange
    const { subject, workers } = rig();
    subject.reconcile([wanted(A)]);
    workers[0]?.ready();

    // Act
    const looking = subject.request(A, { kind: 'pane' });
    const look = workers[0]?.lastLook();
    workers[0]?.answer({
      kind: 'answered',
      session: A,
      generation: look?.generation ?? 0,
      request: look?.request ?? 0,
      failure: 'the pane is gone',
      metrics: { children: [] },
    });

    // Assert
    await should(looking).be.rejectedWith('the pane is gone');
    await should(subject.request(B, { kind: 'pane' })).be.rejectedWith(/no worker observes/);
  });

  it('should forward facts and a moved binding, and detach a session that stopped', () => {
    // Arrange
    const { subject, workers, advance } = rig();
    subject.reconcile([wanted(A)]);
    workers[0]?.ready();

    // Act
    subject.facts(A, { status: 'running', turn: 2 });
    subject.facts(B, { status: 'running', turn: 2 });
    subject.reconcile([wanted(A)]);
    subject.reconcile([wanted(A, 'fy-a-relaunched')]);
    subject.reconcile([]);
    advance(2_000);

    // Assert — the thread is drained, then ended.
    should(workers[0]?.kinds()).deepEqual(['probe', 'attach', 'facts', 'bind', 'detach']);
    should(workers[0]?.terminated).be.true();
    should(subject.hosts(A)).be.false();
  });

  it('should give a session that arrives while a thread drains a thread of its own, and still end the empty one', () => {
    // Arrange
    const { subject, workers, advance } = rig(1);
    subject.reconcile([wanted(A)]);
    workers[0]?.ready();
    subject.reconcile([]);

    // Act
    subject.reconcile([wanted(B)]);
    advance(2_000);

    // Assert — an emptied thread is never handed new work: it ends after its drain.
    should(workers.length).equal(2);
    workers[1]?.ready();
    should(workers[0]?.terminated).be.true();
    should(subject.hosts(B)).be.true();
  });

  it('should end a crashed thread, refuse its looks, ignore its generation, and restart after back-off', async () => {
    // Arrange
    const { subject, workers, advance } = rig();
    subject.reconcile([wanted(A)]);
    workers[0]?.ready();
    const looking = subject.request(A, { kind: 'pane' });
    const stale = workers[0]?.lastLook();

    // Act
    workers[0]?.fail('segfault in a parser');
    subject.reconcile([wanted(A)]);
    const duringBackoff = workers.length;
    advance(1_000);
    subject.reconcile([wanted(A)]);
    workers[1]?.ready();
    workers[0]?.answer({
      kind: 'answered',
      session: A,
      generation: stale?.generation ?? 0,
      request: stale?.request ?? 0,
      metrics: { children: [] },
    });

    // Assert
    await should(looking).be.rejectedWith(/segfault in a parser/);
    should(workers[0]?.terminated).be.true();
    should(duringBackoff).equal(1);
    should(subject.hosts(A)).be.true();
    const attach = workers[1]?.sent.find(message => 'kind' in message && message.kind === 'attach');
    should(attach !== undefined && 'generation' in attach ? attach.generation : undefined).equal(2);
  });

  it('should end a thread that leaves a look unanswered, and one that exits or faults fatally', async () => {
    // Arrange
    const { subject, workers, advance } = rig(8, { lookTimeoutMs: 500 });
    subject.reconcile([wanted(A), wanted(B)]);
    workers[0]?.ready();
    workers[1]?.ready();

    // Act
    const stuck = subject.request(A, { kind: 'pane' });
    advance(500);
    workers[1]?.answer({ kind: 'fault', message: 'not fatal', fatal: false });
    const afterSoftFault = workers[1]?.terminated;
    workers[1]?.answer({ kind: 'fault', message: 'fatal', fatal: true });

    // Assert
    await should(stuck).be.rejectedWith(/no answer within 500 ms/);
    should(workers[0]?.terminated).be.true();
    should(afterSoftFault).be.false();
    should(workers[1]?.terminated).be.true();
  });

  it('should keep a session inline after five crashes in ten minutes, and say so once', () => {
    // Arrange
    const { subject, workers, notices, advance } = rig();

    // Act — five crashes, each after its back-off.
    for (let crash = 0; crash < 5; crash += 1) {
      subject.reconcile([wanted(A)]);
      const worker = workers.at(-1);
      worker?.ready();
      worker?.exit();
      advance(60_000);
    }
    subject.reconcile([wanted(A)]);

    // Assert
    should(workers.length).equal(5);
    should(subject.hosts(A)).be.false();
    should(notices.length).equal(1);
    should(notices[0]).match(/crashed its session worker 5 times/);
  });

  it('should end every thread and refuse every waiting look when closed, and start nothing after', async () => {
    // Arrange
    const { subject, workers } = rig();
    subject.reconcile([wanted(A)]);
    workers[0]?.ready();
    const looking = subject.request(A, { kind: 'pane' });

    // Act
    subject.close();
    subject.reconcile([wanted(B)]);

    // Assert
    await should(looking).be.rejectedWith(/closed/);
    should(workers[0]?.terminated).be.true();
    should(workers.length).equal(1);
  });

  it('should still end a thread whose termination throws because it is already gone', async () => {
    // Arrange — a thread that crashes and then cannot be terminated, as one that has already exited.
    const { subject, workers, advance } = rig();
    subject.reconcile([wanted(A)]);
    const worker = workers[0] as ScriptedWorker;
    worker.ready();
    worker.terminate = () => {
      throw new Error('the thread is already gone');
    };
    const looking = subject.request(A, { kind: 'pane' });

    // Act
    worker.fail('crashed before it could be terminated');
    advance(1_000);
    subject.reconcile([wanted(A)]);

    // Assert — the failed termination changes nothing: the look is refused, the thread is gone from
    // the pool, and the session gets a fresh thread once its back-off is over.
    await should(looking).be.rejectedWith(/crashed before it could be terminated/);
    should(workers.length).equal(2);
    workers[1]?.ready();
    should(subject.hosts(A)).be.true();
  });

  it('should treat a thread it cannot post to as crashed', () => {
    // Arrange
    const { subject, workers } = rig();
    subject.reconcile([wanted(A)]);
    const worker = workers[0] as ScriptedWorker;
    worker.ready();
    worker.postMessage = () => {
      throw new Error('the port is closed');
    };

    // Act
    subject.facts(A, { status: 'running', turn: 3 });

    // Assert
    should(worker.terminated).be.true();
    should(subject.hosts(A)).be.false();
  });
});
