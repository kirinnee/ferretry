import { describe, it } from 'bun:test';
import { SessionStatusSchema, type TerminalHolder } from '@ferretry/protocol';
import should from 'should';
import { ManagedTerminalService, TerminalServiceError } from '../../../src/adapters/index.ts';
import { standingOfSessionStatus } from '../../../src/lib/terminal/holders.ts';
import type {
  TerminalCapture,
  TerminalOwnerDirectory,
  TerminalOwnerStanding,
  TerminalRecord,
  TerminalRuntimePort,
} from '../../../src/lib/index.ts';

const SCREEN: TerminalCapture = { lines: [], cols: 100, rows: 1, cursorX: 0, cursorY: 0, historySize: 0 };

function record(ownerId: string, id: string): TerminalRecord {
  return {
    id,
    ownerId,
    title: `Terminal ${id}`,
    root: '/tmp/worktree',
    tmuxSession: `fy-webterm-${ownerId}-${id}`,
    createdAtMs: 1_000,
    lastActivityAtMs: 1_000,
    cols: 100,
    rows: 30,
  };
}

/** A tmux that holds the given sessions and refuses to kill the ones named in `stuck`. */
class FakeTmux implements TerminalRuntimePort {
  readonly killed: string[] = [];
  readonly sessions = new Map<string, TerminalRecord>();

  constructor(
    held: readonly TerminalRecord[],
    private readonly stuck: ReadonlySet<string> = new Set(),
  ) {
    for (const entry of held) this.sessions.set(entry.id, entry);
  }

  async list(): Promise<readonly TerminalRecord[]> {
    return [...this.sessions.values()];
  }
  async create(input: Parameters<TerminalRuntimePort['create']>[0]): Promise<TerminalRecord> {
    const created = record(input.ownerId, input.id);
    this.sessions.set(created.id, created);
    return created;
  }
  async rename(): Promise<void> {}
  async resize(): Promise<void> {}
  async write(): Promise<void> {}
  async capture(): Promise<TerminalCapture> {
    return SCREEN;
  }
  async text(): Promise<string> {
    return '';
  }
  async foreground(): Promise<string> {
    return 'bash';
  }
  async kill(target: TerminalRecord): Promise<void> {
    if (this.stuck.has(target.id)) throw new Error('tmux refused');
    this.killed.push(target.tmuxSession);
    this.sessions.delete(target.id);
  }
}

const STANDINGS: Record<string, TerminalOwnerStanding> = {
  fitzgerald: { standing: 'finished', status: 'stopped', label: 'fitzgerald' },
  aime: { standing: 'live', status: 'running', label: 'aime' },
  ghost: { standing: 'gone', status: 'removed', label: 'ghost' },
};

const directory: TerminalOwnerDirectory = {
  standing: async ownerId => STANDINGS[ownerId] ?? { standing: 'live', status: 'unknown', label: ownerId },
};

interface Closed {
  readonly holder: TerminalHolder;
  readonly trigger: string;
}

function subject(
  held: readonly TerminalRecord[],
  options: { stuck?: ReadonlySet<string>; owners?: TerminalOwnerDirectory | null; onClosedFails?: boolean } = {},
) {
  const tmux = new FakeTmux(held, options.stuck);
  const closed: Closed[] = [];
  const owners = options.owners === null ? {} : { owners: options.owners ?? directory };
  const service = new ManagedTerminalService(
    tmux,
    { resolve: async () => ({ id: 'newcomer', cwd: '/tmp/worktree' }) },
    { now: () => 2_000 },
    { next: () => 'abcdef012345' },
    {
      maximumPerSession: 2,
      maximumGlobal: 6,
      idleTimeoutMs: 500,
      ...owners,
      onClosed: async (holder, trigger) => {
        closed.push({ holder, trigger });
        if (options.onClosedFails === true) throw new Error('journal down');
      },
    },
  );
  return { tmux, service, closed };
}

const FINISHED = [record('fitzgerald', 'a1'), record('fitzgerald', 'a2'), record('fitzgerald', 'a3')];
const LIVE = [record('aime', 'b1'), record('aime', 'b2')];
const ORPHAN = [record('ghost', 'c1')];

describe('ManagedTerminalService reclaiming finished terminals', () => {
  it('should close the terminals of a stopped ferret and say who lost how many', async () => {
    // Arrange
    const { tmux, service, closed } = subject([...FINISHED, ...LIVE]);

    // Act
    const result = await service.closeFinished('sweep');

    // Assert
    should(result.closed).equal(3);
    should(result.failed).equal(0);
    should(tmux.killed).deepEqual(['fy-webterm-fitzgerald-a1', 'fy-webterm-fitzgerald-a2', 'fy-webterm-fitzgerald-a3']);
    should(closed.map(entry => [entry.holder.sessionId, entry.holder.count, entry.trigger])).deepEqual([
      ['fitzgerald', 3, 'sweep'],
    ]);
  });

  it('should close the terminals of an owner that no longer exists, as a daemon booting would find them', async () => {
    // Arrange
    const { tmux, service, closed } = subject([...ORPHAN, ...LIVE]);

    // Act
    const result = await service.closeFinished('boot');

    // Assert
    should(result.closed).equal(1);
    should(tmux.killed).deepEqual(['fy-webterm-ghost-c1']);
    should(closed.map(entry => [entry.holder.sessionId, entry.holder.standing, entry.trigger])).deepEqual([
      ['ghost', 'gone', 'boot'],
    ]);
  });

  it('should leave a live ferret, and one nobody can place, alone', async () => {
    // Arrange
    const { tmux, service, closed } = subject([...LIVE, record('mystery', 'd1')]);

    // Act
    const result = await service.closeFinished('owner');

    // Assert
    should(result).deepEqual({ closed: 0, failed: 0, holders: [] });
    should(tmux.killed).deepEqual([]);
    should(closed).deepEqual([]);
  });

  it('should leave everything alone when it has no directory to ask', async () => {
    // Arrange
    const { tmux, service } = subject([...FINISHED], { owners: null });

    // Act
    const result = await service.closeFinished('sweep');

    // Assert
    should(result.closed).equal(0);
    should(tmux.killed).deepEqual([]);
  });

  it('should count a terminal tmux refuses to close, close the rest, and keep the stuck one for next time', async () => {
    // Arrange
    const { tmux, service } = subject([...FINISHED], { stuck: new Set(['a2']) });

    // Act
    const first = await service.closeFinished('sweep');
    const second = await service.closeFinished('sweep');

    // Assert
    should(first.closed).equal(2);
    should(first.failed).equal(1);
    should(second.closed).equal(0);
    should(second.failed).equal(1);
    should([...tmux.sessions.keys()]).deepEqual(['a2']);
  });

  it('should still close them when the journal line cannot be written', async () => {
    // Arrange
    const { tmux, service } = subject([...FINISHED], { onClosedFails: true });

    // Act
    const result = await service.closeFinished('sweep');

    // Assert
    should(result.closed).equal(3);
    should(tmux.killed.length).equal(3);
  });

  it('should free the slots so a new terminal can open afterwards', async () => {
    // Arrange
    const { service } = subject([...FINISHED, ...LIVE, ...ORPHAN]);
    await should(service.create('newcomer')).be.rejectedWith(TerminalServiceError);

    // Act
    await service.closeFinished('owner');
    const created = await service.create('newcomer');

    // Assert
    should(created.id).equal('abcdef012345');
  });
});

describe('ManagedTerminalService saying who holds the slots', () => {
  it('should name the holders in the refusal when the machine is full', async () => {
    // Arrange
    const { service } = subject([...FINISHED, ...LIVE, ...ORPHAN]);

    // Act
    const refusal = await service.create('newcomer').catch((error: unknown) => error);

    // Assert
    should(refusal).be.instanceOf(TerminalServiceError);
    should((refusal as Error).message).containEql('6 terminals open: 3 by fitzgerald (stopped)');
    should((refusal as Error).message).containEql('fy terminal close --all-finished');
  });

  it('should fall back to the plain refusal when the directory cannot answer', async () => {
    // Arrange
    const broken: TerminalOwnerDirectory = {
      standing: async () => {
        throw new Error('storage down');
      },
    };
    const { service } = subject([...FINISHED, ...LIVE, ...ORPHAN], { owners: broken });

    // Act
    const refusal = await service.create('newcomer').catch((error: unknown) => error);

    // Assert
    should((refusal as Error).message).equal('global terminal capacity reached: 6 terminals open.');
  });

  it('should report the limit, the open count and the holders for the owner to see', async () => {
    // Arrange
    const { service } = subject([...FINISHED, ...LIVE, ...ORPHAN]);

    // Act
    const view = await service.holders();

    // Assert
    should(view.limit).equal(6);
    should(view.open).equal(6);
    should(view.holders.map(entry => [entry.label, entry.standing, entry.count])).deepEqual([
      ['fitzgerald', 'finished', 3],
      ['aime', 'live', 2],
      ['ghost', 'gone', 1],
    ]);
  });
});

describe('ManagedTerminalService and a ferret that is live but idle', () => {
  it('should close only the terminals of stopped, completed and removed ferrets, whatever status a live one is in', async () => {
    // Arrange
    const statuses = [...SessionStatusSchema.options, undefined];
    const held = statuses.map((_status, index) => record(`owner-${String(index)}`, `t${String(index)}`));
    const byOwner = new Map(statuses.map((status, index) => [`owner-${String(index)}`, status]));
    const owners: TerminalOwnerDirectory = {
      standing: async ownerId => ({ ...standingOfSessionStatus(byOwner.get(ownerId)), label: ownerId }),
    };
    const { tmux, service } = subject(held, { owners });

    // Act
    const result = await service.closeFinished('sweep');

    // Assert
    const survivors = [...tmux.sessions.values()].map(entry => byOwner.get(entry.ownerId));
    should(result.closed).equal(3);
    should(
      survivors.filter(status => status === 'completed' || status === 'stopped' || status === undefined),
    ).deepEqual([]);
    should(survivors).have.length(SessionStatusSchema.options.length - 2);
    should(survivors).containEql('awaiting_user');
    should(survivors).containEql('rate_limited');
    should(survivors).containEql('waiting');
  });
});
