import { describe, it } from 'bun:test';
import should from 'should';
import { parseSessionId, type ClockPort, type SerialExecutor, type SessionId } from '../../../../src/lib/index.ts';
import {
  InvalidDeadlineRefused,
  SessionSignalService,
  SignalRefused,
  UnknownPeerRefused,
  type SignalArtifacts,
  type SignalRepository,
  type SignalTarget,
  type SignalTerminal,
  type SignalTransition,
} from '../../../../src/lib/session/signal/index.ts';

/**
 * What the daemon does about each of the four things a session may say about itself.
 *
 * The ORDER is most of what is under test. A completion writes its evidence before the pane is
 * touched, a park refuses everything it can refuse before it writes anything at all, and neither
 * ordering is visible in the state document afterwards — only in the sequence of calls the ports saw.
 */

const ID = parseSessionId('session-1');
const PEER = parseSessionId('session-2');
const NOW = '2026-08-01T12:00:00.000Z';

function target(overrides: Partial<SignalTarget> = {}): SignalTarget {
  return { id: ID, status: 'running', mode: 'auto', turn: 3, ...overrides };
}

class FakeRepository implements SignalRepository {
  readonly transitions: SignalTransition[] = [];
  readonly peerLookups: string[] = [];

  constructor(
    private current: SignalTarget | undefined,
    private readonly peers: Readonly<Record<string, SignalTarget>> = {},
  ) {}

  async read(): Promise<SignalTarget | undefined> {
    return this.current;
  }

  async resolvePeer(reference: string): Promise<SignalTarget | undefined> {
    this.peerLookups.push(reference);
    return this.peers[reference];
  }

  async transition(_id: SessionId, change: SignalTransition): Promise<SignalTarget> {
    this.transitions.push(change);
    const base = this.current ?? target();
    this.current = {
      ...base,
      ...(change.status === undefined ? {} : { status: change.status }),
      ...(change.waiting === undefined
        ? {}
        : change.waiting === 'clear'
          ? { waiting: undefined }
          : { waiting: change.waiting }),
      ...(change.waitingCreditSeconds === undefined ? {} : { waitingCreditSeconds: change.waitingCreditSeconds }),
    };
    return this.current;
  }

  get events(): readonly string[] {
    return this.transitions.map(change => change.event);
  }
}

class FakeArtifacts implements SignalArtifacts {
  readonly calls: string[] = [];
  readonly summaries: Array<string | undefined> = [];
  readonly doneTurns: number[] = [];
  readonly questions: string[] = [];
  failure: Error | undefined;

  async writeSummary(_id: SessionId, message: string | undefined): Promise<void> {
    this.calls.push('summary');
    this.summaries.push(message);
    if (this.failure) throw this.failure;
  }

  async markDone(_id: SessionId, turn: number): Promise<void> {
    this.calls.push('done');
    this.doneTurns.push(turn);
  }

  async raiseQuestion(_id: SessionId, message: string): Promise<void> {
    this.calls.push('question');
    this.questions.push(message);
  }
}

class FakeTerminal implements SignalTerminal {
  readonly calls: string[] = [];
  readonly reasons: string[] = [];

  async snapshot(): Promise<void> {
    this.calls.push('snapshot');
  }

  async stop(_id: SessionId, reason: string): Promise<void> {
    this.calls.push('stop');
    this.reasons.push(reason);
  }
}

/** Records that every mutation went through a keyed lock, and runs the work inline. */
class RecordingSerial implements SerialExecutor {
  readonly keys: string[] = [];

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    this.keys.push(key);
    return await work();
  }

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    return await work();
  }
}

function clockAt(instant: string): ClockPort {
  return { now: () => instant };
}

interface Parts {
  readonly service: SessionSignalService;
  readonly repository: FakeRepository;
  readonly artifacts: FakeArtifacts;
  readonly terminal: FakeTerminal;
  readonly serial: RecordingSerial;
}

function parts(
  current: SignalTarget = target(),
  peers: Readonly<Record<string, SignalTarget>> = {},
  instant = NOW,
): Parts {
  return build(current, peers, instant);
}

/** The same wiring over a storage that holds no such session, which a default argument cannot express. */
function partsWithoutSession(): Parts {
  return build(undefined, {}, NOW);
}

function build(
  current: SignalTarget | undefined,
  peers: Readonly<Record<string, SignalTarget>>,
  instant: string,
): Parts {
  const repository = new FakeRepository(current, peers);
  const artifacts = new FakeArtifacts();
  const terminal = new FakeTerminal();
  const serial = new RecordingSerial();
  return {
    service: new SessionSignalService({ repository, artifacts, terminal, serial, clock: clockAt(instant) }),
    repository,
    artifacts,
    terminal,
    serial,
  };
}

describe('a session signalling that it is done', () => {
  it('should write its evidence before it touches the pane, then record the completion', async () => {
    // THE ORDERING IS THE TEST. The summary and the turn-certified marker are the only account of the
    // work that survives the kill; a completion that retired the pane first and then died would leave
    // a finished session indistinguishable from one that crashed at the finish line.
    // Arrange
    const { service, repository, artifacts, terminal } = parts();

    // Act
    const result = await service.signal({ id: ID, kind: 'done', message: 'shipped the port' });

    // Assert
    should(artifacts.calls).deepEqual(['summary', 'done']);
    should(terminal.calls).deepEqual(['snapshot', 'stop']);
    should(artifacts.summaries).deepEqual(['shipped the port']);
    // The marker certifies the turn the session is actually on, from the state document.
    should(artifacts.doneTurns).deepEqual([3]);
    should(terminal.reasons).deepEqual(['completion']);
    should(repository.transitions).deepEqual([
      {
        event: 'session.completed',
        status: 'completed',
        health: 'idle',
        reason: 'done marker written',
        finishedAt: NOW,
        promptReady: false,
      },
    ]);
    should(result.status).equal('completed');
  });

  it('should still write a summary when the teammate gave no message', async () => {
    // The summary is what a human opens after the agent is gone. An absent file reads as a session
    // that never finished, so the adapter is always asked to write one.
    // Arrange
    const { service, artifacts } = parts();

    // Act
    await service.signal({ id: ID, kind: 'done' });

    // Assert
    should(artifacts.summaries).deepEqual([undefined]);
    should(artifacts.calls).deepEqual(['summary', 'done']);
  });

  it('should not retire the pane when the evidence could not be written', async () => {
    // A completion whose summary failed is not a completion. Killing the pane anyway would destroy the
    // only remaining source of what the agent did.
    // Arrange
    const { service, artifacts, terminal, repository } = parts();
    artifacts.failure = new Error('disk full');

    // Act
    const failure = await service.signal({ id: ID, kind: 'done' }).catch((error: unknown) => error);

    // Assert
    should(failure).be.an.Error();
    should(terminal.calls).be.empty();
    should(repository.transitions).be.empty();
  });
});

describe('a session signalling that it needs a human', () => {
  it('should record the question and fail an automode teammate for having asked', async () => {
    // The asymmetry is the point: an automode teammate has nobody watching, so a question is an agent
    // that has stopped and will never be answered. `waiting` exists for the legitimate case.
    // Arrange
    const { service, repository, artifacts, terminal } = parts();

    // Act
    const result = await service.signal({ id: ID, kind: 'help', message: 'which branch?' });

    // Assert
    should(artifacts.questions).deepEqual(['which branch?']);
    should(terminal.calls).deepEqual(['snapshot', 'stop']);
    should(terminal.reasons).deepEqual(['automode help protocol violation']);
    should(repository.transitions).deepEqual([
      {
        event: 'session.protocol_violation',
        status: 'failed',
        health: 'crashed',
        reason: 'automode teammate requested user input',
        finishedAt: NOW,
        promptReady: false,
      },
    ]);
    should(result.status).equal('failed');
  });

  it('should leave an interactive session waiting at its prompt with the question as the reason', async () => {
    // Arrange
    const { service, repository, terminal } = parts(target({ mode: 'interactive' }));

    // Act
    const result = await service.signal({ id: ID, kind: 'help', message: 'which branch?' });

    // Assert
    // The pane is untouched: there is a person at this keyboard and the agent is still there to answer.
    should(terminal.calls).be.empty();
    should(repository.transitions).deepEqual([
      {
        event: 'interaction.help',
        status: 'waiting',
        health: 'waiting',
        reason: 'which branch?',
        promptReady: true,
      },
    ]);
    should(result.status).equal('waiting');
  });

  it('should refuse a help signal with no question in it', async () => {
    // Arrange
    const { service, artifacts } = parts();

    // Act
    const absent = await service.signal({ id: ID, kind: 'help' }).catch((error: unknown) => error);
    const blank = await service.signal({ id: ID, kind: 'help', message: '   ' }).catch((error: unknown) => error);

    // Assert
    should(absent).be.instanceof(SignalRefused);
    should(blank).be.instanceof(SignalRefused);
    should(artifacts.calls).be.empty();
  });
});

describe('a session declaring a wait', () => {
  it('should record the deadline, the condition and the resolved peer', async () => {
    // Arrange
    const { service, repository } = parts(target(), { hayden: { ...target({ id: PEER }), teammate: 'hayden' } });

    // Act
    const result = await service.signal({
      id: ID,
      kind: 'waiting',
      until: '30m',
      condition: 'CI run',
      peer: 'hayden',
    });

    // Assert
    should(repository.peerLookups).deepEqual(['hayden']);
    const change = repository.transitions[0];
    should(change?.event).equal('session.waiting');
    should(change?.status).equal('waiting');
    should(change?.health).equal('waiting');
    should(change?.waiting).deepEqual({
      since: NOW,
      until: '2026-08-01T12:30:00.000Z',
      condition: 'CI run',
      // The resolved id, so a callsign reassigned later cannot redirect the park.
      peer: PEER,
      peerName: 'hayden',
    });
    // The reason names the peer over the condition: it says who has to reply for the park to end.
    should(change?.reason).equal('waiting: reply from hayden — until 2026-08-01T12:30:00.000Z');
    should(change?.data).deepEqual({
      until: '2026-08-01T12:30:00.000Z',
      condition: 'CI run',
      peer: PEER,
      peerName: 'hayden',
    });
    should(result.status).equal('waiting');
  });

  it('should park open-ended with nulls in the journal rather than absent keys', async () => {
    // The journal is read as a table, so a park with no deadline records `null` for one — an absent
    // key would be indistinguishable from an event written before the field existed.
    // Arrange
    const { service, repository } = parts();

    // Act
    await service.signal({ id: ID, kind: 'waiting', message: 'thinking' });

    // Assert
    should(repository.transitions[0]?.waiting).deepEqual({ since: NOW });
    should(repository.transitions[0]?.data).deepEqual({ until: null, condition: null });
    should(repository.transitions[0]?.reason).equal('waiting: thinking — open-ended');
  });

  it('should record a peer with no callsign as a null name rather than omitting it', async () => {
    // Arrange
    const { service, repository } = parts(target(), { 'session-2': target({ id: PEER }) });

    // Act
    await service.signal({ id: ID, kind: 'waiting', peer: 'session-2' });

    // Assert
    should(repository.transitions[0]?.data).deepEqual({ until: null, condition: null, peer: PEER, peerName: null });
  });

  it('should refuse a park from a status some other path already reached a verdict on', async () => {
    // A park suspends the supervision that produced the verdict. Letting a stalled session declare a
    // four-hour wait would be the stall hiding behind the feature that exists to tell them apart.
    // Arrange / Act / Assert
    for (const status of ['completed', 'failed', 'stalled', 'stopped', 'kill_failed'] as const) {
      const { service, repository } = parts(target({ status }));
      const refusal = await service.signal({ id: ID, kind: 'waiting' }).catch((error: unknown) => error);
      should(refusal).be.instanceof(SignalRefused);
      should((refusal as Error).message).match(/resume it before declaring a wait/u);
      should(repository.transitions).be.empty();
    }
  });

  it('should refuse an unreadable deadline before it writes anything', async () => {
    // Arrange
    const { service, repository } = parts();

    // Act
    const refusal = await service.signal({ id: ID, kind: 'waiting', until: '45' }).catch((error: unknown) => error);

    // Assert
    should(refusal).be.instanceof(InvalidDeadlineRefused);
    should(repository.transitions).be.empty();
  });

  it('should refuse a peer that resolves to nobody, so a typo cannot become an immortal session', async () => {
    // Parking on a name that resolves to nothing suspends the reflex layer awaiting a reply that can
    // never arrive. The backstop would eventually wake it, but hours late and with no explanation.
    // Arrange
    const { service, repository } = parts();

    // Act
    const refusal = await service.signal({ id: ID, kind: 'waiting', peer: 'haydn' }).catch((error: unknown) => error);

    // Assert
    should(refusal).be.instanceof(UnknownPeerRefused);
    should((refusal as Error).message).match(/"haydn"/u);
    should(repository.transitions).be.empty();
  });

  it('should refuse a session waiting on a reply from itself', async () => {
    // Arrange
    const { service, repository } = parts(target(), { me: target() });

    // Act
    const refusal = await service.signal({ id: ID, kind: 'waiting', peer: 'me' }).catch((error: unknown) => error);

    // Assert
    should(refusal).be.instanceof(SignalRefused);
    should((refusal as Error).message).match(/cannot wait on a reply from itself/u);
    should(repository.transitions).be.empty();
  });
});

describe('a session signalling that it is working again', () => {
  it('should clear the park, credit the time back, and re-anchor the activity ledger', async () => {
    // Arrange
    const parked = target({ waiting: { since: '2026-08-01T11:58:00.000Z' }, waitingCreditSeconds: 60 });
    const { service, repository } = parts(parked);

    // Act
    const result = await service.signal({ id: ID, kind: 'working' });

    // Assert
    should(repository.transitions).deepEqual([
      {
        event: 'session.waiting_cleared',
        status: 'running',
        health: 'healthy',
        reason: 'signalled working',
        waiting: 'clear',
        // 60 already banked plus the 120 seconds this park lasted.
        waitingCreditSeconds: 180,
        // Leaving a park produces no life-signs, so the very next supervision tick would otherwise
        // nudge — or reap — the teammate that just came back.
        reanchorActivity: true,
        data: { reason: 'signalled working', parkedSeconds: 120, waitingCreditSeconds: 180 },
      },
    ]);
    should(result.waiting).be.undefined();
  });

  it('should write nothing when the session was not parked', async () => {
    // A session that is not waiting is already working. Writing a transition would restamp its
    // activity ledger for no reason and hide a genuine stall.
    // Arrange
    const { service, repository } = parts();

    // Act
    const result = await service.signal({ id: ID, kind: 'working' });

    // Assert
    should(repository.transitions).be.empty();
    should(result.status).equal('running');
  });

  it('should not resurrect a protected status when the park it held ends', async () => {
    // A park that outlived its session must not turn a stopped record back into a running one.
    // Arrange
    const { service, repository } = parts(
      target({ status: 'stopped', waiting: { since: '2026-08-01T11:59:00.000Z' } }),
    );

    // Act
    await service.signal({ id: ID, kind: 'working' });

    // Assert
    const change = repository.transitions[0];
    should(change?.event).equal('session.waiting_cleared');
    should(change?.status).be.undefined();
    should(change?.health).be.undefined();
    // The credit is still banked: the session was genuinely parked for that time.
    should(change?.waitingCreditSeconds).equal(60);
  });
});

describe('a peer replying to a session that was parked on it', () => {
  it('should end the wait, credit the parked time back, and name who replied', async () => {
    // THE HALF THAT WAS MISSING. `park` resolved the peer whose reply would end the wait and wrote it
    // onto the document, and nothing could ever fire this — so every `--peer` park ran to its
    // deadline however promptly the peer answered.
    // Arrange
    const parked = target({ waiting: { since: '2026-08-01T11:58:00.000Z', peer: PEER, peerName: 'iris' } });
    const { service, repository } = parts(parked);

    // Act
    await service.endPeerWait(ID, PEER);

    // Assert
    const change = repository.transitions[0];
    should(change?.event).equal('session.waiting_cleared');
    should(change?.reason).equal('iris replied');
    should(change?.status).equal('running');
    should(change?.waiting).equal('clear');
    should(change?.waitingCreditSeconds).equal(120);
    should(change?.reanchorActivity).be.true();
  });

  it('should fall back to the session id when the peer has no callsign', async () => {
    // Arrange
    const { service, repository } = parts(target({ waiting: { since: '2026-08-01T11:59:00.000Z', peer: PEER } }));

    // Act
    await service.endPeerWait(ID, PEER);

    // Assert
    should(repository.transitions[0]?.reason).equal(`${PEER} replied`);
  });

  it('should leave a wait on somebody else, and a session that is not parked at all, untouched', async () => {
    // Checked HERE rather than by the caller: the session may have been re-parked on a different peer
    // between the send landing and this call, and waking it then resumes a teammate still waiting.
    // Arrange
    const other = parts(target({ waiting: { since: '2026-08-01T11:59:00.000Z', peer: 'session-9' } }));
    const unparked = parts(target());

    // Act
    await other.service.endPeerWait(ID, PEER);
    await unparked.service.endPeerWait(ID, PEER);

    // Assert
    should(other.repository.transitions).be.empty();
    should(unparked.repository.transitions).be.empty();
  });

  it('should write nothing for a session that is not there', async () => {
    // Arrange
    const { service, repository } = partsWithoutSession();

    // Act
    await service.endPeerWait(ID, PEER);

    // Assert
    should(repository.transitions).be.empty();
  });

  it("should run under the recipient's own lock", async () => {
    // Arrange
    const { service, serial } = parts(target({ waiting: { since: '2026-08-01T11:59:00.000Z', peer: PEER } }));

    // Act
    await service.endPeerWait(ID, PEER);

    // Assert
    should(serial.keys).deepEqual([ID]);
  });
});

describe('every signal', () => {
  it('should run under the session"s own lock, so a completion and a park cannot interleave', async () => {
    // Arrange
    const { service, serial } = parts();

    // Act
    await service.signal({ id: ID, kind: 'working' });

    // Assert
    should(serial.keys).deepEqual([ID]);
  });

  it('should refuse a session that is not there rather than inventing one', async () => {
    // Arrange
    const { service, repository } = partsWithoutSession();

    // Act
    const refusal = await service.signal({ id: ID, kind: 'done' }).catch((error: unknown) => error);

    // Assert
    should(refusal).be.instanceof(SignalRefused);
    should((refusal as Error).message).match(/session not found/u);
    should(repository.transitions).be.empty();
  });
});

/**
 * The THIRD way a park ends, after the session saying `working` and the peer replying.
 *
 * All three land on the same `clearWait`, which is the point: the credit against the turn ceiling and
 * the activity re-anchor are one piece of arithmetic, and a monitor with its own copy would drift
 * from the other two the first time either changed.
 */
describe('a declared wait reaching its deadline', () => {
  const WAIT_SINCE = '2026-08-01T11:00:00.000Z';
  const DEADLINE = Date.parse('2026-08-01T11:30:00.000Z');
  const NOW_MS = Date.parse(NOW);

  it('should clear the park, credit the time back, and report the wait it ended', async () => {
    // Arrange
    const { service, repository } = parts(target({ waiting: { since: WAIT_SINCE }, status: 'waiting' }));

    // Act
    const cleared = await service.expireWait(ID, NOW_MS, () => DEADLINE, 'declared wait elapsed');

    // Assert
    should(cleared?.since).equal(WAIT_SINCE);
    should(repository.events).deepEqual(['session.waiting_cleared']);
    should(repository.transitions[0]?.waiting).equal('clear');
    should(repository.transitions[0]?.reanchorActivity).be.true();
    should(repository.transitions[0]?.waitingCreditSeconds).equal(3600);
  });

  it('should clear a park whose own timestamps could not be read at all', async () => {
    // A deadline that cannot be established is supervision switched off for a length of time nobody
    // can state, so the wake is the fail-closed direction — see `WaitExpiryBasis`.
    // Arrange
    const { service, repository } = parts(target({ waiting: { since: 'the other day' }, status: 'waiting' }));

    // Act
    const cleared = await service.expireWait(ID, NOW_MS, () => undefined, 'unreadable');

    // Assert
    should(cleared).not.be.undefined();
    should(repository.events).deepEqual(['session.waiting_cleared']);
  });

  it('should leave a park that was replaced by a longer one under the lock', async () => {
    // Arrange
    const { service, repository } = parts(target({ waiting: { since: WAIT_SINCE }, status: 'waiting' }));

    // Act
    const cleared = await service.expireWait(ID, NOW_MS, () => NOW_MS + 60_000, 'declared wait elapsed');

    // Assert
    should(cleared).be.undefined();
    should(repository.transitions).be.empty();
  });

  it('should do nothing for a session that is not parked at all', async () => {
    // Arrange
    const { service, repository } = parts(target());

    // Act
    const cleared = await service.expireWait(ID, NOW_MS, () => DEADLINE, 'declared wait elapsed');

    // Assert
    should(cleared).be.undefined();
    should(repository.transitions).be.empty();
  });

  it('should do nothing for a session that is not there', async () => {
    // Arrange
    const { service, repository } = partsWithoutSession();

    // Act
    const cleared = await service.expireWait(ID, NOW_MS, () => DEADLINE, 'declared wait elapsed');

    // Assert
    should(cleared).be.undefined();
    should(repository.transitions).be.empty();
  });

  it("should run under the session's own lock", async () => {
    // Arrange
    const { service, serial } = parts(target({ waiting: { since: WAIT_SINCE }, status: 'waiting' }));

    // Act
    await service.expireWait(ID, NOW_MS, () => DEADLINE, 'declared wait elapsed');

    // Assert
    should(serial.keys).deepEqual([ID]);
  });
});

/**
 * `waiting` on the document is the authority for a park; the status is a derived view of it.
 *
 * Without the hold, a park survives on the record while every surface that reads a status shows a
 * running session — which is how kteam's own `signal waiting` tool result erased the park it had just
 * made.
 */
describe('holding the status of a session that is still parked', () => {
  it('should put a drifted status back to waiting and say that it had to', async () => {
    // Arrange
    const { service, repository } = parts(target({ waiting: { since: NOW }, status: 'running' }));

    // Act
    const held = await service.holdWait(ID);

    // Assert
    should(held).be.true();
    should(repository.events).deepEqual(['session.waiting_held']);
    should(repository.transitions[0]?.status).equal('waiting');
    should(repository.transitions[0]?.data).have.property('from', 'running');
  });

  it('should write nothing when the status already agrees with the park', async () => {
    // Arrange
    const { service, repository } = parts(target({ waiting: { since: NOW }, status: 'waiting' }));

    // Act & Assert
    should(await service.holdWait(ID)).be.false();
    should(repository.transitions).be.empty();
  });

  it('should never resurrect a verdict another path already reached', async () => {
    // Arrange
    const { service, repository } = parts(target({ waiting: { since: NOW }, status: 'stopped' }));

    // Act & Assert
    should(await service.holdWait(ID)).be.false();
    should(repository.transitions).be.empty();
  });

  it('should write nothing for a session that is not parked, or not there', async () => {
    // Arrange
    const parked = parts(target({ status: 'running' }));
    const absent = partsWithoutSession();

    // Act & Assert
    should(await parked.service.holdWait(ID)).be.false();
    should(await absent.service.holdWait(ID)).be.false();
    should(parked.repository.transitions).be.empty();
  });
});
