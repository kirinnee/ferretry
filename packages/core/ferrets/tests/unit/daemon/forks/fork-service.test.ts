import { describe, expect, test } from 'bun:test';
import { err, ok } from '@ferretry/std';
import type { FerretId } from '@ferretry/kernel/contract';
import type { ForkPlan, ForkTarget, StartFailure, StartRequest, TurnRef } from '../../../../contract/index.ts';
import {
  ForkService,
  type ForkHarness,
  type ForkPorts,
  type ForkSource,
  type ForkWorktrees,
} from '../../../../daemon/lib/forks/fork-service.ts';

/**
 * THE FORK SERVICE over fakes (synthetic ferrets and harnesses; nothing real). The harness cuts a conversation, core starts a
 * NEW ferret on the cut, and the source is never reached for anything but a read.
 */

const SOURCE = 'F1' as FerretId;
const OTHER = 'F2' as FerretId;
const NEW = 'F9' as FerretId;
const AT: TurnRef = { turn: 3 };
const PERSON = { kind: 'person' } as const;

const source = (overrides: Partial<ForkSource> = {}): ForkSource => ({
  name: 'Quick Otter',
  harness: 'claude-code',
  runtime: 'work',
  login: 'main',
  folder: '/work/repo/pkg',
  running: false,
  ...overrides,
});

interface Calls {
  readonly cuts: { from: FerretId; at: TurnRef | undefined; into: ForkTarget }[];
  readonly discards: ForkPlan[];
  readonly starts: { request: StartRequest; origin: unknown; admission: unknown }[];
  readonly checkouts: { sourcePath: string; branch: string; base: { kind: string } }[];
  readonly inspected: string[];
}

function world(
  options: {
    readonly harness?: Partial<ForkHarness> | 'none';
    /** `false`: the harness's cut carries no way to be discarded. */
    readonly discard?: false;
    readonly start?: (request: StartRequest) => ReturnType<ForkPorts['start']>;
    readonly worktrees?: ForkWorktrees | 'none';
    readonly source?: ForkSource | undefined;
    readonly mayTouch?: ForkPorts['mayTouch'];
  } = {},
) {
  const calls: Calls = { cuts: [], discards: [], starts: [], checkouts: [], inspected: [] };
  const harness: ForkHarness | undefined =
    options.harness === 'none'
      ? undefined
      : {
          fork: async (from, at, into) => {
            calls.cuts.push({ from, at, into });
            const plan: ForkPlan = { from, ...(at === undefined ? {} : { at }), harnessConversation: 'conv-new' };
            return options.discard === false
              ? plan
              : {
                  ...plan,
                  discard: async () => {
                    calls.discards.push(plan);
                  },
                };
          },
          ...options.harness,
        };
  const worktrees: ForkWorktrees | undefined =
    options.worktrees === 'none'
      ? undefined
      : (options.worktrees ?? {
          inspect: async folder => {
            calls.inspected.push(folder);
            return { head: 'abc123' };
          },
          create: async request => {
            calls.checkouts.push(request);
            return {
              cwd: '/managed/repo-1/fork-quick-otter/pkg',
              worktree: { path: '/managed/repo-1/fork-quick-otter', branch: request.branch },
            };
          },
          discard: async () => undefined,
        });
  const ports: ForkPorts = {
    source: ferret => (ferret === SOURCE ? ('source' in options ? options.source : source()) : undefined),
    mayTouch: options.mayTouch ?? (() => true),
    harness: key => (key === 'claude-code' ? harness : undefined),
    start: async (request, origin, admission) => {
      calls.starts.push({ request, origin, admission });
      return options.start === undefined ? ok(NEW) : await options.start(request);
    },
    worktrees: () => worktrees,
    newId: () => 'abcdef12-0000-4000-8000-000000000000',
  };
  return { service: new ForkService(ports), calls };
}

describe('the fork service', () => {
  test('should cut the conversation into the source folder and start a new ferret on it', async () => {
    // Arrange
    const { service, calls } = world();

    // Act
    const forked = await service.fork(SOURCE, AT, { worktree: 'same' }, PERSON);

    // Assert
    expect(forked).toEqual(ok({ ferret: NEW, harnessConversation: 'conv-new', folder: '/work/repo/pkg' }));
    expect(calls.cuts).toEqual([{ from: SOURCE, at: AT, into: { folder: '/work/repo/pkg' } }]);
    expect(calls.starts).toHaveLength(1);
    const start = calls.starts[0];
    expect(start?.request).toMatchObject({
      folder: '/work/repo/pkg',
      harness: 'claude-code',
      runtime: 'work',
      login: 'main',
      harnessConversation: 'conv-new',
      by: 'owner',
    });
    expect(start?.request.parent).toBeUndefined();
    expect(start?.origin).toEqual(PERSON);
    // The conversation is already in the history: the start must not try to stage it from the owner's host.
    expect(start?.admission).toEqual({ conversationInPool: true });
    expect(calls.checkouts).toEqual([]);
    expect(calls.discards).toEqual([]);
  });

  test('should carry a name only when one was asked for', async () => {
    // Arrange
    const named = world();
    const unnamed = world();

    // Act
    await named.service.fork(SOURCE, AT, { worktree: 'same', name: 'second-try' }, PERSON);
    await unnamed.service.fork(SOURCE, AT, { worktree: 'same' }, PERSON);

    // Assert
    expect(named.calls.starts[0]?.request.name).toBe('second-try');
    expect(unnamed.calls.starts[0]?.request.name).toBeUndefined();
  });

  test('should refuse with a named sentence and write nothing when the harness cannot fork', async () => {
    // Arrange
    const { service, calls } = world({ harness: { fork: undefined } });

    // Act
    const forked = await service.fork(SOURCE, AT, { worktree: 'new' }, PERSON);

    // Assert
    expect(forked.ok).toBe(false);
    if (forked.ok) return;
    expect(forked.error.code).toBe('unsupported');
    expect(forked.error.reason).toBe(
      'the claude-code harness cannot fork a conversation yet, so nothing was forked and nothing was written',
    );
    expect(calls.cuts).toEqual([]);
    expect(calls.starts).toEqual([]);
    expect(calls.checkouts).toEqual([]);
    expect(calls.inspected).toEqual([]);
    expect(calls.discards).toEqual([]);
  });

  test('should refuse a harness that is not installed the same way', async () => {
    // Arrange
    const { service, calls } = world({ harness: 'none' });

    // Act
    const forked = await service.fork(SOURCE, AT, { worktree: 'same' }, PERSON);

    // Assert
    expect(forked.ok).toBe(false);
    if (!forked.ok) expect(forked.error.code).toBe('unsupported');
    expect(calls.starts).toEqual([]);
  });

  test('should refuse a ferret that does not exist before anything is read', async () => {
    // Arrange
    const { service, calls } = world();

    // Act
    const forked = await service.fork(OTHER, AT, { worktree: 'same' }, PERSON);

    // Assert
    expect(forked).toEqual(err({ code: 'no_ferret', reason: `there is no ferret ${OTHER} to fork` }));
    expect(calls.cuts).toEqual([]);
  });

  test('should refuse a ferret that is working or starting before the harness or any checkout is touched', async () => {
    // Arrange
    const working = world({ source: source({ running: true }) });

    // Act
    const forked = await working.service.fork(SOURCE, AT, { worktree: 'new' }, PERSON);

    // Assert
    expect(forked.ok).toBe(false);
    if (!forked.ok) {
      expect(forked.error.code).toBe('running');
      expect(forked.error.reason).toContain('working right now');
    }
    expect(working.calls.checkouts).toEqual([]);
    expect(working.calls.cuts).toEqual([]);
    expect(working.calls.starts).toEqual([]);
  });

  test('should let a ferret fork only itself and its helpers, and an agent with no ferret nothing', async () => {
    // Arrange
    const { service, calls } = world({ mayTouch: (caller, target) => caller === SOURCE && target === SOURCE });

    // Act
    const stranger = await service.fork(SOURCE, AT, { worktree: 'same' }, { kind: 'agent', ferret: OTHER });
    const nobody = await service.fork(SOURCE, AT, { worktree: 'same' }, { kind: 'agent' });
    const itself = await service.fork(SOURCE, AT, { worktree: 'same' }, { kind: 'agent', ferret: SOURCE });

    // Assert
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.error.code).toBe('forbidden');
    expect(nobody.ok).toBe(false);
    if (!nobody.ok) expect(nobody.error.code).toBe('forbidden');
    expect(itself.ok).toBe(true);
    expect(calls.cuts).toHaveLength(1);
    // A ferret forking asks for its fork as a helper of its own, never as the owner.
    expect(calls.starts[0]?.request).toMatchObject({ by: 'ferret', parent: SOURCE });
  });

  test('should leave the source untouched and keep the cut when the failed start does not prove cleanup', async () => {
    // Arrange
    const failure: StartFailure = { code: 'login_unavailable', reason: 'the login main is signed out' };
    const { service, calls } = world({ start: async () => err(failure) });

    // Act
    const forked = await service.fork(SOURCE, AT, { worktree: 'same' }, PERSON);

    // Assert
    expect(forked).toEqual(
      err({
        code: 'start',
        reason: `${failure.reason}. The forked conversation conv-new was kept because the launch could not prove it has no live writer`,
        start: failure,
      }),
    );
    expect(calls.discards).toEqual([]);
    // The only thing asked of the source was the cut itself (a read of its home).
    expect(calls.cuts).toHaveLength(1);
  });

  test('should still refuse when the harness has no way to discard a cut it cannot use', async () => {
    // Arrange
    const failure: StartFailure = { code: 'failed', reason: 'the launch failed' };
    const { service, calls } = world({ discard: false, start: async () => err(failure) });

    // Act
    const forked = await service.fork(SOURCE, AT, { worktree: 'same' }, PERSON);

    // Assert
    expect(forked.ok).toBe(false);
    if (!forked.ok) expect(forked.error.code).toBe('start');
    expect(calls.discards).toEqual([]);
  });

  test('should keep the cut when start throws without proving its writer stopped', async () => {
    const { service, calls } = world({
      start: async () => {
        throw new Error('launch failed');
      },
    });

    const forked = await service.fork(SOURCE, AT, { worktree: 'same' }, PERSON);

    expect(forked.ok).toBe(false);
    if (!forked.ok) {
      expect(forked.error.code).toBe('start');
      expect(forked.error.reason).toContain('The forked conversation conv-new was kept');
    }
    expect(calls.discards).toEqual([]);
  });

  test('should start nothing when the cut itself fails', async () => {
    // Arrange
    const { service, calls } = world({
      harness: {
        fork: async () => {
          throw new Error('turn 3 is not in the conversation');
        },
      },
    });

    // Act
    const forked = await service.fork(SOURCE, AT, { worktree: 'same' }, PERSON);

    // Assert
    expect(forked).toEqual(
      err({ code: 'cut', reason: 'the conversation could not be cut: turn 3 is not in the conversation' }),
    );
    expect(calls.starts).toEqual([]);
    expect(calls.discards).toEqual([]);
  });

  test('should make a new worktree from the source head and cut for that folder', async () => {
    // Arrange
    const { service, calls } = world();

    // Act
    const forked = await service.fork(SOURCE, AT, { worktree: 'new' }, PERSON);

    // Assert
    expect(forked).toEqual(
      ok({
        ferret: NEW,
        harnessConversation: 'conv-new',
        folder: '/managed/repo-1/fork-quick-otter/pkg',
        worktree: { path: '/managed/repo-1/fork-quick-otter', branch: 'fork/quick-otter-abcdef12' },
      }),
    );
    expect(calls.inspected).toEqual(['/work/repo/pkg']);
    expect(calls.checkouts).toEqual([
      { sourcePath: '/work/repo/pkg', branch: 'fork/quick-otter-abcdef12', base: { kind: 'head' } },
    ]);
    // The harness is told the NEW folder, because it may key the transcript by it; the ferret starts there too.
    expect(calls.cuts[0]?.into).toEqual({ folder: '/managed/repo-1/fork-quick-otter/pkg' });
    expect(calls.starts[0]?.request.folder).toBe('/managed/repo-1/fork-quick-otter/pkg');
  });

  test('should refuse a new worktree before the cut when this daemon hosts none', async () => {
    // Arrange
    const { service, calls } = world({ worktrees: 'none' });

    // Act
    const forked = await service.fork(SOURCE, AT, { worktree: 'new' }, PERSON);

    // Assert
    expect(forked.ok).toBe(false);
    if (!forked.ok) expect(forked.error.code).toBe('worktree');
    expect(calls.cuts).toEqual([]);
    expect(calls.starts).toEqual([]);
  });

  test('should refuse a new worktree before the cut when the source is not in a Git checkout or the checkout fails', async () => {
    // Arrange
    const notGit = world({
      worktrees: {
        inspect: async () => {
          throw new Error('not a git repository');
        },
        create: async () => {
          throw new Error('unreachable');
        },
        discard: async () => undefined,
      },
    });
    const failing = world({
      worktrees: {
        inspect: async () => ({ head: 'abc123' }),
        create: async () => {
          throw new Error('branch is in use');
        },
        discard: async () => undefined,
      },
    });

    // Act
    const first = await notGit.service.fork(SOURCE, AT, { worktree: 'new' }, PERSON);
    const second = await failing.service.fork(SOURCE, AT, { worktree: 'new' }, PERSON);

    // Assert
    for (const [forked, calls] of [
      [first, notGit.calls],
      [second, failing.calls],
    ] as const) {
      expect(forked.ok).toBe(false);
      if (!forked.ok) expect(forked.error.code).toBe('worktree');
      expect(calls.cuts).toEqual([]);
      expect(calls.starts).toEqual([]);
    }
  });

  test('should name the checkout it left behind when the start fails after making one', async () => {
    // Arrange
    const failure: StartFailure = { code: 'failed', reason: 'the launch failed' };
    const { service } = world({ start: async () => err(failure) });

    // Act
    const forked = await service.fork(SOURCE, AT, { worktree: 'new' }, PERSON);

    // Assert
    expect(forked.ok).toBe(false);
    if (!forked.ok)
      expect(forked.error.reason).toBe(
        'the launch failed. The forked conversation conv-new was kept because the launch could not prove it has no live writer. The new worktree /managed/repo-1/fork-quick-otter was left in place; remove it with fy worktree remove if you do not want it',
      );
  });
});
