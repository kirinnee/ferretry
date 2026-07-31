import { describe, it } from 'bun:test';
import should from 'should';
import {
  SessionLifecycleService,
  type LifecycleClock,
  type SessionLifecycleEvent,
  type SessionLifecycleLauncher,
  type SessionLifecycleRecord,
  type SessionLifecycleRepository,
} from '../../../../src/lib/session/lifecycle/index.ts';

class MemoryRepository implements SessionLifecycleRepository {
  readonly records = new Map<string, SessionLifecycleRecord>();
  readonly events: SessionLifecycleEvent[] = [];

  async read(id: SessionLifecycleRecord['config']['id']): Promise<SessionLifecycleRecord | undefined> {
    return this.records.get(id);
  }

  async write(record: SessionLifecycleRecord, event: SessionLifecycleEvent): Promise<void> {
    this.records.set(record.config.id, record);
    this.events.push(event);
  }
}

class RecordingLauncher implements SessionLifecycleLauncher {
  launches = 0;
  stops = 0;
  launchError: unknown;
  stopError: unknown;

  async launch(): Promise<void> {
    this.launches += 1;
    if (this.launchError) throw this.launchError;
  }

  async stop(): Promise<void> {
    this.stops += 1;
    if (this.stopError) throw this.stopError;
  }
}

class SequenceClock implements LifecycleClock {
  private index = 0;
  constructor(
    private readonly instants = ['2026-07-31T10:00:00.000Z', '2026-07-31T10:01:00.000Z', '2026-07-31T10:02:00.000Z'],
  ) {}
  now(): string {
    return this.instants[this.index++] ?? '2026-07-31T10:03:00.000Z';
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    id: 'service-session',
    agent: '/opt/fleet/agent',
    cwd: '/workspace/project',
    mode: 'auto' as const,
    prompt: 'Build it',
    ...overrides,
  };
}

function createService(): {
  readonly repository: MemoryRepository;
  readonly launcher: RecordingLauncher;
  readonly service: SessionLifecycleService;
} {
  const repository = new MemoryRepository();
  const launcher = new RecordingLauncher();
  return { repository, launcher, service: new SessionLifecycleService(repository, launcher, new SequenceClock()) };
}

describe('SessionLifecycleService', () => {
  it('should persist creation before starting the terminal process', async () => {
    // Arrange
    const { repository, service } = createService();

    // Act
    const record = await service.create(input());

    // Assert
    should(record.state.status).equal('created');
    should(repository.records.get('service-session')).equal(record);
    should(repository.events).deepEqual([
      { type: 'session.created', data: { agent: '/opt/fleet/agent', mode: 'auto', cwd: '/workspace/project' } },
    ]);
  });

  it('should mark a persisted session running only after the launcher succeeds', async () => {
    // Arrange
    const { repository, launcher, service } = createService();
    await service.create(input());

    // Act
    const running = await service.start('service-session');

    // Assert
    should(launcher.launches).equal(1);
    should(running.state.status).equal('running');
    should(repository.events.map(entry => entry.type)).deepEqual([
      'session.created',
      'session.starting',
      'session.running',
    ]);
  });

  it('should preserve a durable failed record when launch fails', async () => {
    // Arrange
    const { repository, launcher, service } = createService();
    launcher.launchError = new Error('tmux unavailable');
    await service.create(input());

    // Act
    let failure: unknown;
    try {
      await service.start('service-session');
    } catch (error) {
      failure = error;
    }

    // Assert
    should(failure).be.instanceOf(Error);
    should(repository.records.get('service-session')?.state).containDeep({
      status: 'failed',
      reason: 'tmux unavailable',
    });
    should(repository.events.map(entry => entry.type)).deepEqual([
      'session.created',
      'session.starting',
      'session.failed',
    ]);
  });

  it('should create and start a session through the single lifecycle path', async () => {
    // Arrange
    const { launcher, service } = createService();

    // Act
    const record = await service.createAndStart(input());

    // Assert
    should(record.state.status).equal('running');
    should(launcher.launches).equal(1);
  });

  it('should stop a live session once and leave an already stopped session untouched', async () => {
    // Arrange
    const { launcher, service } = createService();
    await service.createAndStart(input());

    // Act
    const stopped = await service.stop('service-session', 'work complete');
    const repeated = await service.stop('service-session');

    // Assert
    should(stopped.state).containDeep({ status: 'stopped', reason: 'work complete' });
    should(repeated).equal(stopped);
    should(launcher.stops).equal(1);
  });

  it('should not record a stop when its process cleanup fails', async () => {
    // Arrange
    const { repository, launcher, service } = createService();
    await service.createAndStart(input());
    launcher.stopError = 'tmux did not stop';

    // Act
    let failure: unknown;
    try {
      await service.stop('service-session');
    } catch (error) {
      failure = error;
    }

    // Assert
    should(failure).equal('tmux did not stop');
    should(repository.records.get('service-session')?.state.status).equal('running');
  });

  it('should reject malformed and unknown session identifiers before terminal work', async () => {
    // Arrange
    const { launcher, service } = createService();

    // Act + Assert
    await should(service.start('../escape')).be.rejectedWith(/path-safe/u);
    await should(service.stop('missing')).be.rejectedWith(/session not found/u);
    should(launcher.launches).equal(0);
    should(launcher.stops).equal(0);
  });
});
