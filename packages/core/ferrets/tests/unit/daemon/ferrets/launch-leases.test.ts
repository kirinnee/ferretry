import { describe, expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import {
  ConversationIdSchema,
  ConversationLeaseStore,
  type ConversationLeaseOutcome,
  type HistoryHarness,
} from '../../../../contract/conversation-lease.ts';
import { type FerretRecord, PERSON_ORIGIN, type RunnerHandle, type RunSpec } from '../../../../contract/index.ts';
import { FakeRunner } from '../../../../contract/testing/index.ts';
import {
  ConversationLeases,
  registryLeaseSessions,
} from '../../../../daemon/lib/session/lifecycle/conversation-leases.ts';
import { FerretsService } from '../../../../daemon/lib/ferrets/service.ts';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';
import { MemoryLeaseDisk } from '../../../support/daemon/memory-lease-disk.ts';
import { additivesFixture } from './additives-fixture.ts';

/**
 * Every pane the daemon opens holds its conversation's lease (36d): `fy new`, a resume, a Warden revive and a restart all
 * reach `FerretsService.launch`, so a terminal's `fy history claim` finds the conversation held while the pane runs, the
 * daemon never takes a conversation another live writer holds, and the lease is freed when the ferret stops.
 * Fakes only: the REAL lease store and daemon leases over an in-memory disk.
 */

const NOW = new Date('2026-11-16T10:00:00.000Z');
const OLD = 'conv-old';
const OTHER = parseSessionId('mw7bp89h-61f11260');
const NO_STANDING = async () => 'unknown' as const;

/** A runner whose first pane never says which process runs it, or whose stop fails. */
class AwkwardRunner extends FakeRunner {
  hidePid = false;
  failStop = false;
  override async start(spec: RunSpec) {
    const started = await super.start(spec);
    if (!started.ok || !this.hidePid) return started;
    const { pid: _pid, ...rest } = started.value;
    return ok(rest);
  }
  override async stop(handle: RunnerHandle): Promise<void> {
    if (this.failStop) throw new Error('tmux is unreachable');
    await super.stop(handle);
  }
}

function built(options: { readonly empty?: boolean; readonly resumable?: boolean } = {}) {
  const base = additivesFixture({ ...(options.empty === true ? { empty: true } : {}) });
  if (options.resumable === true)
    base.registry.put({ ...(base.registry.get(base.id) as FerretRecord), harnessConversation: OLD });
  const runner = new AwkwardRunner();
  const disk = new MemoryLeaseDisk();
  const store = new ConversationLeaseStore(disk, () => NOW);
  const leases = new ConversationLeases(
    store,
    registryLeaseSessions(base.registry, async () => ({ status: 'running' })),
    4000,
  );
  const service = new FerretsService(base.registry, base.tokens, { ...base.ports, runner: () => runner, leases });
  /** What `fy history claim` answers for a terminal that wants the conversation. */
  const terminalClaim = async (
    conversation: string,
    harness: HistoryHarness = 'claude',
  ): Promise<ConversationLeaseOutcome> =>
    await store.claim(
      { harness, conversation: ConversationIdSchema.parse(conversation), holder: { pid: 7777 } },
      NO_STANDING,
    );
  const start = async (extra: { readonly harnessConversation?: string } = {}) =>
    await service.start({ by: 'owner', folder: '/work', harness: 'claude-code', ...extra }, PERSON_ORIGIN);
  return { ...base, runner, disk, store, leases, service, terminalClaim, start };
}

describe('a pane the daemon opens holds its conversation', () => {
  test('should refuse a terminal claim for the conversation of a ferret `fy new` started', async () => {
    // Arrange
    const f = built({ empty: true });

    // Act
    const started = await f.start();
    const claim = await f.terminalClaim(`conv-${f.id}`);

    // Assert — held by the pane's own process, not by this daemon
    expect(started.ok).toBe(true);
    expect(claim.kind).toBe('held');
    expect(f.disk.lease('claude', `conv-${f.id}`)?.holder).toMatchObject({ session: f.id, pid: 1001 });
  });

  test('should refuse a terminal claim for the conversation a resume (and so a Warden revive) relaunched', async () => {
    // Arrange
    const f = built({ resumable: true });

    // Act
    const resumed = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
    const claim = await f.terminalClaim(OLD);

    // Assert
    expect(resumed.ok).toBe(true);
    expect(claim.kind).toBe('held');
    expect(f.disk.lease('claude', OLD)?.holder).toMatchObject({ session: f.id, pid: 1001 });
  });

  test('should refuse a terminal claim for the conversation a daemon relaunch (launchHeld) opened', async () => {
    // Arrange
    const f = built({ resumable: true });

    // Act
    const launched = await f.service.launchHeld(f.id);
    const claim = await f.terminalClaim(OLD);

    // Assert
    expect(launched.ok).toBe(true);
    expect(claim.kind).toBe('held');
  });

  test('should renew the lease a lifecycle already claimed for the same session instead of refusing it', async () => {
    // Arrange
    const f = built({ resumable: true });
    await f.leases.claim(f.id, ['/opt/fleet/bin/claude', '--resume', OLD]);

    // Act
    const resumed = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });

    // Assert — one lease, now on the pane's process
    expect(resumed.ok).toBe(true);
    expect([...f.disk.files.keys()]).toEqual([`claude/${OLD}`]);
    expect(f.disk.lease('claude', OLD)?.holder.pid).toBe(1001);
  });
});

describe('a stop frees the lease', () => {
  test('should release the conversation when the ferret is stopped, so a terminal claim then succeeds', async () => {
    // Arrange
    const f = built({ empty: true });
    await f.start();
    expect((await f.terminalClaim(`conv-${f.id}`)).kind).toBe('held');

    // Act
    await f.service.stop(f.id, 'now');
    const claim = await f.terminalClaim(`conv-${f.id}`);

    // Assert
    expect(claim).toMatchObject({ kind: 'claimed', decision: 'create' });
  });

  test('should release the conversation of a ferret whose pane is found gone', async () => {
    // Arrange
    const f = built({ resumable: true });
    await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
    const handle = f.registry.get(f.id)?.handle as RunnerHandle;
    await f.runner.stop(handle);

    // Act
    await f.service.stop(f.id, 'now');

    // Assert
    expect(f.disk.lease('claude', OLD)).toBeUndefined();
  });
});

describe('the daemon never takes a held conversation', () => {
  const holdBy = (f: ReturnType<typeof built>, conversation: string) =>
    f.disk.write(
      'claude',
      ConversationIdSchema.parse(conversation),
      `${JSON.stringify({
        v: 1,
        harness: 'claude',
        conversation,
        holder: { pid: 9, start: 1, session: OTHER },
        since: '2026-11-16T09:00:00.000Z',
      })}\n`,
    );

  test('should refuse a resume of a conversation another live session writes, open no pane and say who holds it', async () => {
    // Arrange
    const f = built({ resumable: true });
    await holdBy(f, OLD);

    // Act
    const resumed = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });

    // Assert
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) {
      expect(resumed.error.code).toBe('refused');
      expect(resumed.error.reason).toContain(`conversation ${OLD} is being written by session ${OTHER}`);
    }
    expect(f.runner.starts).toBe(0);
    expect(f.disk.lease('claude', OLD)?.holder.session).toBe(OTHER);
    expect(f.registry.get(f.id)?.state).toBe('stopped');
  });

  test('should refuse a start bound to a conversation another live session writes', async () => {
    // Arrange
    const f = built({ empty: true });
    await holdBy(f, 'conv-bound');

    // Act
    const started = await f.start({ harnessConversation: 'conv-bound' });

    // Assert
    expect(started.ok).toBe(false);
    expect(f.runner.starts).toBe(0);
    expect(f.disk.lease('claude', 'conv-bound')?.holder.session).toBe(OTHER);
  });
});

describe('a pane whose conversation cannot be held', () => {
  test('should stop the pane and fail the start when the runner cannot say which process runs it', async () => {
    // Arrange
    const f = built({ resumable: true });
    f.runner.hidePid = true;

    // Act
    const resumed = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });

    // Assert — fail closed: no pane left writing a conversation no lease names
    expect(resumed.ok).toBe(false);
    expect(await f.runner.alive('%1' as RunnerHandle)).toBe(false);
    expect(f.registry.get(f.id)?.state).toBe('stopped');
    expect(f.disk.lease('claude', OLD)).toBeUndefined();
  });

  test('should keep the lease when that pane cannot be stopped either', async () => {
    // Arrange
    const f = built({ resumable: true });
    f.runner.hidePid = true;
    f.runner.failStop = true;

    // Act
    const resumed = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });

    // Assert — the pane may still be writing, so its conversation stays held
    expect(resumed.ok).toBe(false);
    expect(f.registry.get(f.id)?.handle).toBeDefined();
    expect(f.disk.lease('claude', OLD)?.holder.session).toBe(f.id);
  });
});

describe('a ferret launched before leases existed', () => {
  test('should be left alone: it stops cleanly with no lease to free, and none is made for it', async () => {
    // Arrange — a pane that was already running before this daemon, so it holds no lease
    const f = built({ resumable: true });
    const handle = f.runner.adoptable(f.id);
    f.registry.put({ ...(f.registry.get(f.id) as FerretRecord), state: 'working', handle });

    // Act
    await f.service.stop(f.id, 'now');

    // Assert
    expect(f.registry.get(f.id)?.state).toBe('stopped');
    expect(f.disk.files.size).toBe(0);
  });
});
