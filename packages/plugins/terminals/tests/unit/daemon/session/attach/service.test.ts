import { describe, it } from 'bun:test';
import should from 'should';
import {
  type ObservedTerminalPane,
  type RegisteredPaneObserver,
  type RegisteredTerminalPane,
  SessionAttachError,
  SessionAttachService,
  type TerminalPaneRegistry,
} from '../../../../../daemon/lib/session/attach/index.ts';

/**
 * Who a local attach is actually authorized by.
 *
 * A session NAME is never evidence. The tmux runner must have recorded the ferret's one pane, and
 * the complete process incarnation behind it — tmux session, pane id,
 * pid and start ticks — must still be there when it is looked at again. Every other state is a
 * refusal, and the refusals are distinct because an operator acts differently on each: a pane that
 * has exited is a session to resume, an unreadable record is damaged daemon state.
 *
 * The second thing asserted throughout is that a refused registration is never OBSERVED. The
 * observer reads a private tmux server by pane id; asking it about a record the domain has already
 * rejected is how a name-shaped candidate would reach the process boundary at all.
 */

const SOCKET = '/state/fy/tmux.sock';
const SESSION = 'msa1ny28-4f0f298e';

const PANE: RegisteredTerminalPane = {
  tmuxSession: `fy-${SESSION}`,
  paneId: '%41',
  pid: 812,
  processStartTicks: 1_002_003,
};

class Registry implements TerminalPaneRegistry {
  /** Every ferret the registry was asked about, so a lookup by anything else is visible. */
  readonly asked: string[] = [];

  constructor(
    /** What the runner recorded, by ferret. */
    private readonly values: ReadonlyMap<string, RegisteredTerminalPane>,
    /** What the durable store refuses with. Its own reader fails closed over malformed evidence
     *  rather than reporting an empty registration set. */
    private readonly failure?: Error,
  ) {}

  async paneOf(sessionId: string): Promise<RegisteredTerminalPane | undefined> {
    this.asked.push(sessionId);
    if (this.failure !== undefined) throw this.failure;
    return this.values.get(sessionId);
  }
}

class Observer implements RegisteredPaneObserver {
  /** Every registration handed to the process boundary, in order. */
  readonly asked: RegisteredTerminalPane[] = [];

  constructor(private readonly observation: ObservedTerminalPane | undefined) {}

  async observe(registration: RegisteredTerminalPane): Promise<ObservedTerminalPane | undefined> {
    this.asked.push(registration);
    return this.observation;
  }
}

interface AttachWorld {
  readonly socketPath?: string;
  /** What the runner recorded for SESSION; explicitly `undefined` for none. */
  readonly registration?: RegisteredTerminalPane | undefined;
  /** What the durable registration store refuses the whole read with. */
  readonly registryFailure?: Error;
  /** Set explicitly to `undefined` for a pane the daemon's own tmux server no longer holds. */
  readonly observation?: ObservedTerminalPane;
}

function subject(world: AttachWorld = {}) {
  const registration = Object.hasOwn(world, 'registration') ? world.registration : PANE;
  const registry = new Registry(
    new Map(registration === undefined ? [] : [[SESSION, registration]]),
    world.registryFailure,
  );
  const observer = new Observer(Object.hasOwn(world, 'observation') ? world.observation : PANE);
  return {
    registry,
    observer,
    service: new SessionAttachService(world.socketPath ?? SOCKET, registry, observer),
  };
}

/** The failure a resolve refused with, or `undefined` when it answered. */
async function refusal(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    if (error instanceof SessionAttachError) return error.failure;
    throw error;
  }
}

describe('SessionAttachService', () => {
  it('should prove an attach target from the pane the runner recorded', async () => {
    // Arrange
    const harness = subject();

    // Act
    const target = await harness.service.resolve(SESSION);

    // Assert — the socket path is the DAEMON's, and every identity field is the registration's; none
    // of it is echoed back from the observation, which is untrusted evidence rather than a source.
    should(target).deepEqual({
      socketPath: SOCKET,
      tmuxSession: PANE.tmuxSession,
      paneId: PANE.paneId,
      pid: PANE.pid,
      processStartTicks: PANE.processStartTicks,
    });
    should(harness.registry.asked).deepEqual([SESSION]);
    should(harness.observer.asked).deepEqual([PANE]);
  });

  it('should refuse a ferret the runner recorded no pane for, without reading tmux', async () => {
    // Arrange — no record for this ferret, and a record that exists only for another ferret.
    const empty = subject({ registration: undefined });
    const other = subject();

    // Act
    const emptyFailure = await refusal(async () => await empty.service.resolve(SESSION));
    const otherFailure = await refusal(async () => await other.service.resolve('another-ferret'));

    // Assert — another ferret's pane is not a candidate, and neither refusal touched the process
    // boundary: a tmux read for an unowned record is the observation this design exists to prevent.
    should([emptyFailure, otherFailure]).deepEqual(['missing_registration', 'missing_registration']);
    should(empty.observer.asked).deepEqual([]);
    should(other.observer.asked).deepEqual([]);
  });

  it('should refuse a registration whose process identity is incomplete', async () => {
    // Arrange — each is one missing half of the incarnation the reap rules demand.
    const worlds = [
      { ...PANE, tmuxSession: '' },
      { ...PANE, paneId: '41' },
      { ...PANE, paneId: '%' },
      { ...PANE, pid: 1 },
      { ...PANE, processStartTicks: 0 },
    ].map(registration => subject({ registration }));

    // Act
    const failures = [];
    for (const world of worlds) failures.push(await refusal(async () => await world.service.resolve(SESSION)));

    // Assert
    should(failures).deepEqual(Array.from({ length: 5 }, () => 'invalid_registration'));
    should(worlds.flatMap(world => world.observer.asked)).deepEqual([]);
  });

  it('should refuse when the runner’s record cannot be read', async () => {
    // Arrange — the record fails closed over unreadable or malformed evidence rather than
    // reporting no pane.
    const harness = subject({ registryFailure: new Error('pane registration record failed validation') });

    // Act
    const failure = await refusal(async () => await harness.service.resolve(SESSION));

    // Assert — damaged evidence is damaged daemon state, NOT the absence of a registration. Reading
    // it as `missing_registration` would tell an operator the pane is gone and invite them to resume
    // a session whose terminal is very likely still running.
    should(failure).equal('invalid_registration');
    should(harness.observer.asked).deepEqual([]);
  });

  it('should refuse when the registered pane is no longer live on this daemon', async () => {
    // Arrange
    const harness = subject({ observation: undefined });

    // Act
    const failure = await refusal(async () => await harness.service.resolve(SESSION));

    // Assert — distinct from a mismatch: nothing answers at that address at all.
    should(failure).equal('pane_unavailable');
    should(harness.observer.asked).deepEqual([PANE]);
  });

  it('should refuse a live pane whose incarnation no longer matches the registration', async () => {
    // Arrange — a recycled pid, a re-created tmux session and a re-numbered pane are all the same
    // class of lie: the address still resolves, but not to the process that was registered.
    const recycled = subject({ observation: { ...PANE, processStartTicks: PANE.processStartTicks + 1 } });
    const renamed = subject({ observation: { ...PANE, tmuxSession: 'fy-somebody-else' } });
    const renumbered = subject({ observation: { ...PANE, paneId: '%42' } });
    const reused = subject({ observation: { ...PANE, pid: PANE.pid + 1 } });

    // Act
    const failures = [];
    for (const world of [recycled, renamed, renumbered, reused])
      failures.push(await refusal(async () => await world.service.resolve(SESSION)));

    // Assert
    should(failures).deepEqual(Array.from({ length: 4 }, () => 'identity_mismatch'));
  });

  it('should refuse a live pane whose own observed identity is not complete', async () => {
    // Arrange — the observation is checked by the SAME rules as the registration, so a tmux read that
    // came back with a blank pane id cannot be waved through just because the registration was sound.
    const harness = subject({ observation: { ...PANE, paneId: '' } });

    // Act
    const failure = await refusal(async () => await harness.service.resolve(SESSION));

    // Assert
    should(failure).equal('identity_mismatch');
  });

  it('should refuse before any lookup when its own attach identity is unusable', async () => {
    // Arrange — a tmux socket that is not an absolute path, and an empty session id. Neither can be
    // authorized against, so neither reaches the registry.
    const relative = subject({ socketPath: 'tmux.sock' });
    const blank = subject();

    // Act
    const failures = [
      await refusal(async () => await relative.service.resolve(SESSION)),
      await refusal(async () => await blank.service.resolve('')),
    ];

    // Assert
    should(failures).deepEqual(Array.from({ length: 2 }, () => 'invalid_registration'));
    should([...relative.registry.asked, ...blank.registry.asked]).deepEqual([]);
  });

  it('should name the session in every refusal it raises', async () => {
    // Arrange
    const harness = subject({ observation: undefined });

    // Act
    const error = await harness.service.resolve(SESSION).catch((thrown: unknown) => thrown);

    // Assert — a refusal an operator cannot attribute to a session is a refusal they cannot act on.
    should(error instanceof SessionAttachError).be.true();
    should((error as SessionAttachError).name).equal('SessionAttachError');
    should((error as SessionAttachError).message).containEql(SESSION);
  });
});
