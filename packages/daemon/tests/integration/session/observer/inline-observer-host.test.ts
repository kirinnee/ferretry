/**
 * THE INLINE OBSERVER HOST over real storage: what it reads, what it is told, and what it answers.
 *
 * The point of stage 3a's `facts` hook is that the 2 s turn tick stops re-reading every session's state
 * document to learn fields this daemon wrote itself. These tests count the reads: a session storage has
 * told the host about is never read by a tick, one it was never told about is read once, and a read that
 * raced a write never puts the older document back.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  type DaemonStorage,
  DaemonStorageFactory,
  InlineObserverHost,
  type InlineObserverPorts,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SessionObservationApplier,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../../src/adapters/index.ts';
import {
  type AnswerOperationRecord,
  type LivenessTarget,
  parseSessionId,
  type SessionId,
  SessionObserver,
  type TranscriptEvent,
  type TurnPaneEvidence,
} from '../../../../src/lib/index.ts';

const NOW = '2026-10-22T08:00:00.000Z';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const A = parseSessionId('observed-a');
const B = parseSessionId('observed-b');
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
  const home = await mkdtemp(join(tmpdir(), 'fy-observer-host-'));
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

interface World {
  readonly storage: DaemonStorage;
  readonly reads: SessionId[];
  readonly events: Map<string, readonly TranscriptEvent[]>;
  readonly ledger: Map<SessionId, ReadonlyMap<string, AnswerOperationRecord>>;
  readonly yields: number[];
  readonly looks: string[];
  /** When set, the next state read waits for it before answering. */
  gate?: Promise<void>;
  busy?: SessionId;
  brokenLedger?: SessionId;
}

async function world(): Promise<World> {
  const storage = await openStorage();
  const reads: SessionId[] = [];
  const subject: World = { storage, reads, events: new Map(), ledger: new Map(), yields: [], looks: [] };
  const readState = storage.readState.bind(storage);
  storage.readState = async id => {
    reads.push(id);
    const gate = subject.gate;
    subject.gate = undefined;
    const value = await readState(id);
    if (gate !== undefined) await gate;
    return value;
  };
  return subject;
}

function host(subject: World, overrides: Partial<InlineObserverPorts> = {}): InlineObserverHost {
  const answers = {
    all: async (id: SessionId) => {
      if (subject.brokenLedger === id) throw new Error('the answer ledger is damaged');
      return subject.ledger.get(id) ?? new Map();
    },
    append: async () => undefined,
  };
  const serial = new KeyedSerialExecutor();
  return new InlineObserverHost(
    {
      storage: subject.storage,
      questionRoster: () => subject.storage.listSessions().map(session => session.id),
      tail: {
        tail: async (id, limit) => {
          const events = subject.events.get(id);
          return events === undefined ? { kind: 'unresolved' } : { kind: 'read', events: events.slice(-limit) };
        },
      },
      pane: async () => BUSY,
      answers,
      answerSerial: {
        runIfIdle: async (key, work) => (subject.busy === key ? undefined : await serial.runIfIdle(key, work)),
      },
      applier: new SessionObservationApplier(subject.storage, answers, new KeyedSerialExecutor()),
      liveness: {
        screen: async id => {
          subject.looks.push(`screen ${id}`);
          if (id === B) throw new Error('no terminal');
          return '1 background terminal running';
        },
        transcript: async (id, lines) => {
          subject.looks.push(`transcript ${id} ${lines}`);
          return 'the last lines';
        },
        processes: async tmuxSession => {
          subject.looks.push(`processes ${tmuxSession}`);
          return { kind: 'observed', processes: [] };
        },
      },
      clock: { now: () => NOW },
      yieldToLoop: async () => {
        subject.yields.push(subject.yields.length);
      },
      paneState: async () => undefined,
      sendEvidence: { read: async () => ({ readable: true, inputs: [] }) },
      every: () => () => undefined,
      ...overrides,
    },
    new SessionObserver(text => `digest(${text})`),
  );
}

const turnStateOf = async (subject: World, id: SessionId) =>
  ((await subject.storage.readState(id)) as Record<string, unknown>).turnState;

describe('InlineObserverHost — facts', () => {
  it('should never read a state document storage told it about, and read an untold one once', async () => {
    // Arrange — A was written before the host existed; B after, so storage tells the host about it.
    const subject = await world();
    await subject.storage.writeState(A, { id: A, status: 'running', turn: 1 });
    const observer = host(subject);
    await subject.storage.writeState(B, { id: B, status: 'running', turn: 1 });
    subject.reads.length = 0;

    // Act
    await observer.turns.run();
    await observer.turns.run();
    await observer.turns.run();
    const reads = [...subject.reads];

    // Assert — A once (the tick that met it untold); B never. Both are working: the host wrote that.
    should(reads).deepEqual([A]);
    subject.reads.length = 0;
    should(await turnStateOf(subject, A)).equal('working');
    should(await turnStateOf(subject, B)).equal('working');
  });

  it('should learn a write at once: a stop clears the turn on the next tick, without a read', async () => {
    // Arrange
    const subject = await world();
    const observer = host(subject);
    await subject.storage.writeState(A, { id: A, status: 'running', turn: 1 });
    await observer.turns.run();

    // Act
    await subject.storage.updateState(A, raw => ({ ...(raw as Record<string, unknown>), status: 'stopped' }));
    subject.reads.length = 0;
    const report = await observer.turns.run();
    const reads = [...subject.reads];

    // Assert
    should(reads).deepEqual([]);
    should([...(report?.changed.values() ?? [])]).deepEqual([{ from: 'working', to: undefined }]);
    should(await turnStateOf(subject, A)).be.undefined();
  });

  it('should leave alone an ended session with nothing to settle, and read again one that does not parse', async () => {
    // Arrange
    const subject = await world();
    const observer = host(subject);
    await subject.storage.writeState(A, { id: A, status: 'stopped', turn: 1 });
    await subject.storage.writeState(B, { id: B, status: 'not-a-status' });
    subject.reads.length = 0;

    // Act
    const first = await observer.turns.run();
    const second = await observer.turns.run();

    // Assert — B's document never parsed, so every tick looks again, as the watcher always did.
    should(subject.reads).deepEqual([B, B]);
    should(first?.changed.size).equal(0);
    should(second?.failures.size).equal(0);
  });

  it('should never let a read that raced a write put the older document back', async () => {
    // Arrange — A is untold; its first read is held until a write has landed and been told.
    const subject = await world();
    await subject.storage.writeState(A, { id: A, status: 'running', turn: 1, turnState: 'working' });
    const observer = host(subject);
    let release: () => void = () => undefined;
    subject.gate = new Promise(resolve => {
      release = resolve;
    });

    // Act
    const tick = observer.turns.run();
    await Bun.sleep(20);
    await subject.storage.updateState(A, raw => ({ ...(raw as Record<string, unknown>), status: 'stopped' }));
    release();
    await tick;
    subject.reads.length = 0;
    await observer.turns.run();

    // Assert — the read that raced is not remembered: the tick decides from the stop storage told of, so
    // the turn is cleared, and the next tick has nothing left to settle and reads nothing.
    should(subject.reads).deepEqual([]);
    should(await turnStateOf(subject, A)).be.undefined();
  });

  it('should count the sessions it last saw mid-turn', async () => {
    // Arrange
    const subject = await world();
    const observer = host(subject);
    await subject.storage.writeState(A, { id: A, status: 'running', turn: 1, turnState: 'working' });
    await subject.storage.writeState(B, { id: B, status: 'running', turn: 1, turnState: 'your-turn' });

    // Act + Assert
    should(await observer.midTurn()).equal(1);
  });
});

describe('InlineObserverHost — armed', () => {
  it('should observe the whole fleet on its own 2 s tick once armed, arm it once, and stop it on close', async () => {
    // Arrange
    const subject = await world();
    await subject.storage.writeState(A, { id: A, status: 'running', turn: 1 });
    const ticks: { readonly intervalMs: number; readonly tick: () => void; cancelled: boolean }[] = [];
    const observer = host(subject, {
      every: (intervalMs, tick) => {
        const armed = { intervalMs, tick, cancelled: false };
        ticks.push(armed);
        return () => {
          armed.cancelled = true;
        };
      },
    });

    // Act
    observer.arm();
    observer.arm();
    ticks[0]?.tick();
    for (let wait = 0; wait < 100 && (await turnStateOf(subject, A)) === undefined; wait += 1) await Bun.sleep(5);
    observer.close();
    observer.close();

    // Assert
    should(ticks.map(armed => [armed.intervalMs, armed.cancelled])).deepEqual([[observer.turns.intervalMs, true]]);
    should(await turnStateOf(subject, A)).equal('working');
  });
});

describe('InlineObserverHost — questions', () => {
  it('should project each live session, hand the loop back between them, and report the one that failed', async () => {
    // Arrange
    const subject = await world();
    const observer = host(subject);
    await subject.storage.writeState(A, { id: A, status: 'running', turn: 1 });
    await subject.storage.writeState(B, { id: B, status: 'running', turn: 1 });
    subject.events.set(A, [question]);
    subject.events.set(B, [question]);
    subject.brokenLedger = B;

    // Act
    const failures = await observer.questions();

    // Assert
    should([...failures.entries()]).deepEqual([[B, 'the answer ledger is damaged']]);
    should(subject.yields).deepEqual([0, 1]);
    const projected = (await subject.storage.readState(A)) as Record<string, unknown>;
    should(projected.status).equal('awaiting_question');
    should((projected.pendingQuestion as { toolUseId: string }).toolUseId).equal('tool-1');
  });

  it('should leave the document alone when the transcript is unproved, the document does not parse, or a drive holds the session', async () => {
    // Arrange
    const subject = await world();
    const observer = host(subject);
    await subject.storage.writeState(A, { id: A, status: 'running', turn: 1 });
    await subject.storage.writeState(B, { id: B, status: 'not-a-status' });
    subject.events.set(B, [question]);

    // Act
    await observer.project(A);
    await observer.project(B);
    subject.events.set(A, [question]);
    subject.busy = A;
    await observer.project(A);

    // Assert
    should(await subject.storage.readState(A)).deepEqual({ id: A, status: 'running', turn: 1 });
    should(await subject.storage.readState(B)).deepEqual({ id: B, status: 'not-a-status' });
  });

  it('should refresh what it was told from the document a question look read', async () => {
    // Arrange — told nothing about A: it was written before the host existed, then looked at.
    const subject = await world();
    await subject.storage.writeState(A, { id: A, status: 'running', turn: 1, turnState: 'working' });
    const observer = host(subject);
    subject.events.set(A, []);
    await observer.project(A);
    subject.reads.length = 0;

    // Act
    await observer.turns.run();

    // Assert — the question look's read stood in for the tick's.
    should(subject.reads).deepEqual([]);
  });
});

describe('InlineObserverHost — liveness', () => {
  const target = (id: SessionId, tmuxSession?: string): LivenessTarget => ({
    id,
    status: 'running',
    turn: 1,
    mode: 'auto',
    waiting: false,
    ...(tmuxSession === undefined ? {} : { tmuxSession }),
  });

  it('should sample the screen, the transcript tail and the pane processes, keeping only digests of the text', async () => {
    // Arrange
    const subject = await world();
    const observer = host(subject);

    // Act
    const actual = await observer.liveness(target(A, 'fy-a'));

    // Assert
    should(subject.looks).deepEqual([`screen ${A}`, `transcript ${A} 20`, 'processes fy-a']);
    should(actual).deepEqual({
      pane: '1 background terminal running',
      paneHash: 'digest(1 background terminal running)',
      transcriptHash: 'digest(the last lines)',
      subprocessAlive: true,
    });
  });

  it('should leave out what it could not read, and not ask for processes without a pane', async () => {
    // Arrange
    const subject = await world();
    const observer = host(subject, {
      liveness: {
        screen: async () => {
          throw new Error('no terminal');
        },
        transcript: async () => {
          throw new Error('unresolved');
        },
        processes: async () => {
          throw new Error('must not be asked');
        },
      },
    });

    // Act
    const actual = await observer.liveness(target(B));

    // Assert
    should(actual).deepEqual({});
  });
});

describe('InlineObserverHost — the other reads', () => {
  it('should answer the live frame and the send evidence through this thread, and skip what a worker observes', async () => {
    // Arrange
    const subject = await world();
    const observer = host(subject);
    await subject.storage.writeState(A, { id: A, status: 'running', turn: 1 });
    subject.events.set(A, []);

    // Act
    const pane = await observer.pane(A);
    const evidence = await observer.sendEvidence(A, '2026-10-22T08:00:00.000Z');
    const failures = await observer.questions(id => id === A);

    // Assert
    should(pane).be.undefined();
    should(evidence).deepEqual({ readable: true, inputs: [] });
    should(failures.size).equal(0);
    should(subject.yields).deepEqual([]);
  });
});
