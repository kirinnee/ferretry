import { expect, test } from 'bun:test';
import { factsOfKey } from '../../../support/daemon/harness-facts.ts';
import { ok } from '@ferretry/std';
import { ConversationLeaseStore } from '../../../../contract/conversation-lease.ts';
import { PERSON_ORIGIN, type RunnerHandle, type RunSpec } from '../../../../contract/index.ts';
import { FakeRunner } from '../../../../contract/testing/index.ts';
import { FerretsService } from '../../../../daemon/lib/ferrets/service.ts';
import { ForkService } from '../../../../daemon/lib/forks/fork-service.ts';
import {
  ConversationLeases,
  registryLeaseSessions,
} from '../../../../daemon/lib/session/lifecycle/conversation-leases.ts';
import { MemoryLeaseDisk } from '../../../support/daemon/memory-lease-disk.ts';
import { additivesFixture } from '../ferrets/additives-fixture.ts';

/** A real launch opens a synthetic pane, cannot bind its lease to a pid, then cannot stop it. */
class UnstoppableRunner extends FakeRunner {
  readonly stopAttempts: RunnerHandle[] = [];
  override async start(spec: RunSpec) {
    const result = await super.start(spec);
    if (!result.ok) return result;
    const { pid: _pid, ...pane } = result.value;
    return ok(pane);
  }
  override async stop(handle: RunnerHandle): Promise<void> {
    this.stopAttempts.push(handle);
    throw new Error('the synthetic runner cannot stop');
  }
}

test('a failed fork start whose pane cannot stop retains its cut and the live conversation lease', async () => {
  const base = additivesFixture({ empty: true });
  const runner = new UnstoppableRunner();
  const disk = new MemoryLeaseDisk();
  const leases = new ConversationLeases(
    new ConversationLeaseStore(disk, () => new Date('2026-11-16T10:00:00Z')),
    registryLeaseSessions(base.registry, async () => ({ status: 'running' }), factsOfKey),
    4000,
  );
  const launch = new FerretsService(base.registry, base.tokens, { ...base.ports, runner: () => runner, leases });
  let discarded = false;
  const forks = new ForkService({
    source: () => ({ name: 'source', harness: 'claude-code', folder: '/work', running: false }),
    mayTouch: () => true,
    harness: () => ({
      fork: async from => ({
        from,
        harnessConversation: 'conv-cut',
        discard: async () => {
          discarded = true;
        },
      }),
    }),
    start: async (...args) => await launch.start(...args),
    worktrees: () => undefined,
    newId: () => 'unused',
  });

  const result = await forks.fork(base.id, { turn: 1 }, { worktree: 'same' }, PERSON_ORIGIN);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatchObject({ code: 'start', start: { code: 'runner_unavailable' } });
  expect(runner.stopAttempts).toHaveLength(1);
  expect(base.registry.get(base.id)?.handle).toBe(runner.stopAttempts[0]);
  expect(disk.lease('claude', 'conv-cut')?.holder.session).toBe(base.id);
  expect(discarded).toBe(false);
  expect(result.error.reason).toContain('The forked conversation conv-cut was kept');
});
