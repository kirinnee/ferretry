import { AsyncResource } from 'node:async_hooks';
import { afterEach, describe, expect, it } from 'bun:test';
import { type Actor } from '@ferretry/kernel/contract';
import { currentActor, runInCall } from '@ferretry/kernel/host';
import { type FerretId, type FerretRecord, type RunnerHandle } from '../../../../../contract/index.ts';
import { FakeRunner, T0 as RECORD_T0 } from '../../../../../contract/testing/index.ts';
import { buildTurnWatch } from '../../../../../daemon/modules/turn-watch.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import { memoryStorage, RecordingLog, sessionConfig } from '../../../../support/daemon/storage.ts';

const AT = '2026-11-08T10:00:00.000Z';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A runner whose look says which actor the kernel would stamp on the act it runs in. */
class ActorRunner extends FakeRunner {
  readonly actors: Actor[] = [];
  override async look(handle: RunnerHandle) {
    this.actors.push(currentActor());
    return await super.look(handle);
  }
}

describe('the turn watch looks as the observer’s own actor', () => {
  it('stamps every look `ferret` even when the watch is armed inside a call made by an owner', async () => {
    // Arrange: a live ferret, and a timer that (like the kernel's) carries the context it was armed in.
    const made = await memoryStorage({ clock: { now: () => AT } });
    cleanups.push(async () => await made.storage.close());
    const id = parseSessionId('actor-1');
    await made.storage.writeConfig(id, sessionConfig(id));
    await made.storage.writeState(id, { id, status: 'running', turn: 1, turnState: 'working', turnStateAt: AT });
    const runner = new ActorRunner();
    const record = {
      format: 1,
      id: id as unknown as FerretId,
      name: id,
      role: 'lead',
      harness: 'claude-code',
      runner: 'tmux',
      folder: '/work/actor-1',
      state: 'working',
      handle: runner.adoptable(id as unknown as FerretId),
      createdAt: RECORD_T0,
      stateAt: RECORD_T0,
    } as FerretRecord;
    let timer: (() => void) | undefined;
    const { host } = buildTurnWatch({
      storage: made.storage,
      tail: { tail: async () => ({ kind: 'unresolved' }) },
      record: () => record,
      runner: () => runner,
      turnObserved: async () => undefined,
      clock: { now: () => AT },
      every: (_intervalMs, tick) => {
        timer = AsyncResource.bind(tick);
        return () => undefined;
      },
      yieldToLoop: async () => undefined,
      log: new RecordingLog(),
    });

    // Act: armed inside a call an owner's tool made, then ticked by the timer from outside it.
    await runInCall({ actor: 'owner-tools' }, async () => host.arm());
    timer?.();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert
    expect(runner.actors.length).toBeGreaterThan(0);
    expect(new Set(runner.actors)).toEqual(new Set<Actor>(['ferret']));
  });
});
