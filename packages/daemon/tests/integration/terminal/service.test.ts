import { describe, it } from 'bun:test';
import should from 'should';
import { ManagedTerminalService, TerminalServiceError } from '../../../src/adapters/index.ts';
import type {
  TerminalCapture,
  TerminalRecord,
  TerminalRuntimePort,
  TerminalSessionResolver,
} from '../../../src/lib/index.ts';

/** What the fake pane shows. */
const SCREEN: TerminalCapture = { lines: ['ready $'], cols: 100, rows: 1, cursorX: 7, cursorY: 0, historySize: 0 };

const base: TerminalRecord = {
  id: '0123456789ab',
  ownerId: 'session-a',
  title: 'Terminal 1',
  root: '/tmp/worktree',
  tmuxSession: 'fy-webterm-session-a-0123456789ab',
  createdAtMs: 1_000,
  lastActivityAtMs: 1_000,
  cols: 100,
  rows: 30,
};

class FakeRuntime implements TerminalRuntimePort {
  readonly calls: string[] = [];
  readonly records = new Map<string, TerminalRecord>();

  async list(): Promise<readonly TerminalRecord[]> {
    this.calls.push('list');
    return [...this.records.values()];
  }
  async create(input: Parameters<TerminalRuntimePort['create']>[0]): Promise<TerminalRecord> {
    this.calls.push('create');
    const record = {
      ...base,
      id: input.id,
      ownerId: input.ownerId,
      title: input.title,
      root: input.cwd,
      ...input.size,
      ...(input.openedBy === undefined ? {} : { openedBy: input.openedBy }),
      ...(input.name === undefined ? {} : { name: input.name }),
    };
    this.records.set(record.id, record);
    return record;
  }
  async rename(record: TerminalRecord, title: string): Promise<void> {
    this.calls.push('rename');
    this.records.set(record.id, { ...record, title });
  }
  async resize(record: TerminalRecord, size: { readonly cols: number; readonly rows: number }): Promise<void> {
    this.calls.push('resize');
    this.records.set(record.id, { ...record, ...size });
  }
  async write(_record: TerminalRecord, _bytes: Uint8Array): Promise<void> {
    this.calls.push('write');
  }
  async capture(_record: TerminalRecord): Promise<TerminalCapture> {
    this.calls.push('capture');
    return SCREEN;
  }
  async text(_record: TerminalRecord, lines: number): Promise<string> {
    this.calls.push(`text:${String(lines)}`);
    return 'ready $';
  }
  async foreground(_record: TerminalRecord): Promise<string> {
    this.calls.push('foreground');
    return 'sleep';
  }
  async kill(record: TerminalRecord): Promise<void> {
    this.calls.push('kill');
    this.records.delete(record.id);
  }
}

const sessions: TerminalSessionResolver = {
  resolve: async reference => (reference === 'missing' ? undefined : { id: 'session-a', cwd: '/tmp/worktree' }),
};

function subject(runtime = new FakeRuntime(), maximumPerSession = 2) {
  return {
    runtime,
    service: new ManagedTerminalService(
      runtime,
      sessions,
      { now: () => 2_000 },
      { next: () => 'abcdef012345' },
      { maximumPerSession, maximumGlobal: 3, idleTimeoutMs: 500 },
    ),
  };
}

describe('ManagedTerminalService', () => {
  it('should carry a derived opener onto the pane and through every later read', async () => {
    // The service never sees a request body, so it cannot decide ownership — it
    // forwards what the mount derived from the credential. What it MUST get
    // right is that the opener survives the refresh cycle: `list` rebuilds every
    // record from the runtime, and an opener lost there would make a terminal
    // read as unrecorded moments after it was correctly attributed.
    // Arrange
    const { service } = subject();
    const unattributed = subject().service;
    const openedBy = { by: 'agent', sessionId: 'mse7wwti-2a75bd9c' } as const;

    // Act
    const created = await service.create('session-a', { openedBy });
    const listed = await service.list('session-a');
    const fetched = await service.get('session-a', created.id);
    const anonymous = await unattributed.create('session-a');

    // Assert
    should(created.openedBy).deepEqual(openedBy);
    should(listed.terminals.map(view => view.openedBy)).deepEqual([openedBy]);
    should(fetched.openedBy).deepEqual(openedBy);
    // A caller the daemon could not attest leaves the field ABSENT, which is how
    // the wire says "unrecorded" — not `null`, and not a benign default.
    should(anonymous).not.have.property('openedBy');
  });

  it('should create, list, read, rename, resize, write, capture, and close an isolated terminal', async () => {
    // Arrange
    const { runtime, service } = subject();

    // Act
    const created = await service.create('session-a');
    const listed = await service.list('session-a');
    const read = await service.get('session-a', created.id);
    const renamed = await service.rename('session-a', created.id, ' shell ');
    const resized = await service.resize('session-a', created.id, 200, 40);
    await service.write('session-a', created.id, Uint8Array.of(13));
    const captured = await service.capture('session-a', created.id, 200);
    await service.close('session-a', created.id);

    // Assert
    should(created).match({ title: 'Terminal 1', viewers: 0, idleDeadline: '1970-01-01T00:00:01.500Z' });
    should(listed.terminals).have.length(1);
    should(read.id).equal(created.id);
    should(renamed.title).equal('shell');
    should(resized).deepEqual({ cols: 200, rows: 40 });
    should(captured).equal(SCREEN);
    // A route lists tmux before it answers; a stream's write and capture act on the terminal the service
    // already knows, so neither costs a `list` — that extra process used to sit in front of every echo.
    should(runtime.calls).deepEqual([
      'list',
      'create',
      'list',
      'list',
      'list',
      'rename',
      'list',
      'resize',
      'write',
      'capture',
      'list',
      'kill',
    ]);
  });

  it('should reject missing sessions, missing terminals, invalid names, and capacity exhaustion', async () => {
    // Arrange
    const { service } = subject(undefined, 1);

    // Act + Assert
    await should(service.list('missing')).be.rejectedWith(TerminalServiceError);
    await should(service.get('session-a', base.id)).be.rejectedWith(TerminalServiceError);
    await should(service.create('session-a', { title: '' })).be.rejected();
    await service.create('session-a', { title: 'one' });
    await should(service.create('session-a', { title: 'two' })).be.rejectedWith(TerminalServiceError);
  });

  it('should enforce the global capacity and only resolve sessions rooted at absolute paths', async () => {
    // Arrange
    const runtime = new FakeRuntime();
    runtime.records.set(base.id, base);
    runtime.records.set('abcdef012345', { ...base, id: 'abcdef012345', ownerId: 'other' });
    runtime.records.set('fedcba012345', { ...base, id: 'fedcba012345', ownerId: 'other-two' });
    const service = new ManagedTerminalService(
      runtime,
      sessions,
      { now: () => 1 },
      { next: () => 'abcdef012345' },
      { maximumGlobal: 3 },
    );
    const relative = new ManagedTerminalService(
      runtime,
      { resolve: async () => ({ id: 'session-a', cwd: 'relative' }) },
      { now: () => 1 },
      { next: () => 'abcdef012345' },
    );

    // Act + Assert
    await should(service.create('session-a')).be.rejectedWith(TerminalServiceError);
    await should(relative.list('session-a')).be.rejectedWith(TerminalServiceError);
  });
  it("should still refuse a stream's write or capture once the lifecycle has closed its terminal", async () => {
    // Arrange
    const { runtime, service } = subject();
    const created = await service.create('session-a');
    await service.close('session-a', created.id);
    runtime.calls.length = 0;

    // Act + Assert — unknown to the service, so each falls back to a fresh list, which no longer has it.
    await should(service.write('session-a', created.id, Uint8Array.of(13))).be.rejectedWith(TerminalServiceError);
    await should(service.capture('session-a', created.id, 200)).be.rejectedWith(TerminalServiceError);
    should(runtime.calls).deepEqual(['list', 'list']);
  });
});

describe('ManagedTerminalService names, folders and agent reads', () => {
  const named = (isDirectory?: (path: string) => Promise<boolean>) => {
    const runtime = new FakeRuntime();
    let minted = 0;
    const next = (): string => {
      minted += 1;
      return `abcdef01234${String(minted)}`;
    };
    const service = new ManagedTerminalService(
      runtime,
      sessions,
      { now: () => 2_000 },
      { next },
      { maximumPerSession: 4, ...(isDirectory === undefined ? {} : { isDirectory }) },
    );
    return { runtime, service };
  };

  it('should keep a name on the terminal and refuse a second terminal with the same name', async () => {
    // Arrange
    const { service } = named();

    // Act
    const dev = await service.create('session-a', { name: 'dev' });
    const listed = await service.list('session-a');

    // Assert
    should(dev.name).equal('dev');
    should(listed.terminals.map(terminal => terminal.name)).deepEqual(['dev']);
    should(await service.create('session-a', { name: 'dev' }).catch((error: unknown) => error))
      .be.instanceOf(TerminalServiceError)
      .and.have.property('code', 'conflict');
    should(await service.create('session-a')).not.have.property('name');
  });

  it('should open a terminal in a folder that exists, relative to the session or absolute', async () => {
    // Arrange
    const asked: string[] = [];
    const { runtime, service } = named(async path => {
      asked.push(path);
      return path !== '/tmp/worktree/missing';
    });

    // Act
    const relative = await service.create('session-a', { name: 'web', folder: 'web/../app' });
    const absolute = await service.create('session-a', { name: 'logs', folder: '/var/log/' });

    // Assert
    should(asked).deepEqual(['/tmp/worktree/app', '/var/log']);
    should(runtime.records.get(relative.id)?.root).equal('/tmp/worktree/app');
    should(runtime.records.get(absolute.id)?.root).equal('/var/log');
    should(await service.create('session-a', { folder: 'missing' }).catch((error: unknown) => error)).match({
      code: 'bad_request',
      message: 'there is no folder /tmp/worktree/missing to open a terminal in',
    });
  });

  it('should refuse a folder when it has no way to prove one exists', async () => {
    // tmux would silently start the shell in the daemon's own folder instead, which is a shell
    // somewhere nobody asked for.
    const { service } = named();
    should(await service.create('session-a', { folder: '/tmp' }).catch((error: unknown) => error)).match({
      code: 'bad_request',
    });
  });

  it('should read a terminal as text and name its foreground program', async () => {
    // Arrange
    const { runtime, service } = named();
    const dev = await service.create('session-a', { name: 'dev' });

    // Act
    const text = await service.text('session-a', dev.id, 120);
    const foreground = await service.foreground('session-a', dev.id);

    // Assert
    should(text).equal('ready $');
    should(foreground).equal('sleep');
    should(runtime.calls).containDeep(['text:120', 'foreground']);
  });
});

describe('ManagedTerminalService — one create at a time', () => {
  it('should give two racing opens of one name one terminal and one refusal, never two terminals', async () => {
    // Arrange — a runtime whose create yields before it lands, as tmux does.
    const runtime = new FakeRuntime();
    const create = runtime.create.bind(runtime);
    runtime.create = async input => {
      await new Promise<void>(resolve => setImmediate(resolve));
      return await create(input);
    };
    let minted = 0;
    const next = (): string => {
      minted += 1;
      return `abcdef01234${String(minted)}`;
    };
    const service = new ManagedTerminalService(
      runtime,
      sessions,
      { now: () => 2_000 },
      { next },
      { maximumPerSession: 4 },
    );

    // Act
    const outcomes = await Promise.allSettled([
      service.create('session-a', { name: 'dev' }),
      service.create('session-a', { name: 'dev' }),
    ]);

    // Assert
    should(outcomes.map(outcome => outcome.status).toSorted()).deepEqual(['fulfilled', 'rejected']);
    should([...runtime.records.values()].filter(record => record.name === 'dev')).have.length(1);
  });
});
