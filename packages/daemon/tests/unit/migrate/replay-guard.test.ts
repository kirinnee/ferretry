import type { SessionView } from '@ferretry/protocol';
import { describe, expect, it } from 'bun:test';
import {
  MIGRATION_REPLAY_CAPACITY,
  MigrationReplayGuard,
  MigrationReplayMismatchError,
  migrationReplayKey,
} from '../../../src/lib/migrate/replay-guard.ts';

const view = (agent: string): SessionView => ({ config: { agent } }) as unknown as SessionView;

const key = (requestId: string, sessionId = 'session-a') => ({ sessionId, requestId });

/** A deferred migration, so an in-flight replay can be observed before the original settles. */
const deferred = () => {
  let settle: (value: SessionView) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const promise = new Promise<SessionView>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
};

/** Every rejection is treated as post-destructive unless a test says otherwise. */
const retainAll = () => true;
const retainNone = () => false;

describe('migrationReplayKey', () => {
  it('separates the same request id on different sessions', () => {
    expect(migrationReplayKey(key('r1', 'session-a'))).not.toBe(migrationReplayKey(key('r1', 'session-b')));
    expect(migrationReplayKey(key('r1'))).toBe(migrationReplayKey(key('r1')));
  });
});

describe('MigrationReplayGuard', () => {
  it('performs one destructive migration for a concurrent in-flight replay, and both observe it', async () => {
    const guard = new MigrationReplayGuard(retainAll);
    const gate = deferred();
    let performed = 0;
    const perform = () => {
      performed += 1;
      return gate.promise;
    };

    const first = guard.run(key('r1'), 'target-a', perform);
    const replay = guard.run(key('r1'), 'target-a', perform);
    // The replay must not have started a second relaunch while the first is still running.
    expect(performed).toBe(1);

    gate.settle(view('codex-auto-atomi'));
    expect((await first).config.agent).toBe('codex-auto-atomi');
    expect((await replay).config.agent).toBe('codex-auto-atomi');
    expect(performed).toBe(1);
  });

  it('replays a completed success without relaunching again', async () => {
    const guard = new MigrationReplayGuard(retainAll);
    let performed = 0;
    const perform = async () => {
      performed += 1;
      return view('codex-auto-atomi');
    };

    expect((await guard.run(key('r1'), 'target-a', perform)).config.agent).toBe('codex-auto-atomi');
    expect((await guard.run(key('r1'), 'target-a', perform)).config.agent).toBe('codex-auto-atomi');
    expect(performed).toBe(1);
  });

  it('lets a pre-destructive refusal be re-evaluated under the same request id', async () => {
    // This is the sheet's "Retry safety check": the preflight refused, nothing was destroyed, the
    // reader resolved the blocker, and asking again must consult the session's CURRENT condition.
    const guard = new MigrationReplayGuard(retainNone);
    const outcomes: Array<() => Promise<SessionView>> = [
      async () => {
        throw new Error('in-flight work refuses this migration');
      },
      async () => view('codex-auto-atomi'),
    ];
    let performed = 0;
    const perform = () => {
      const next = outcomes[performed];
      performed += 1;
      if (next === undefined) throw new Error('performed too many times');
      return next();
    };

    await expect(guard.run(key('r1'), 'target-a', perform)).rejects.toThrow('in-flight work refuses');
    expect((await guard.run(key('r1'), 'target-a', perform)).config.agent).toBe('codex-auto-atomi');
    expect(performed).toBe(2);
  });

  it('never re-attempts a failure that happened after the session was destroyed', async () => {
    // The pane is already killed and the document restamped. An automatic retry 250ms later must be
    // told what happened, not allowed to relaunch a session that has no pane left.
    const guard = new MigrationReplayGuard(retainAll);
    let performed = 0;
    const perform = async (): Promise<SessionView> => {
      performed += 1;
      throw new Error('relaunch failed after the pane was replaced');
    };

    await expect(guard.run(key('r1'), 'target-a', perform)).rejects.toThrow('relaunch failed');
    await expect(guard.run(key('r1'), 'target-a', perform)).rejects.toThrow('relaunch failed');
    await expect(guard.run(key('r1'), 'target-a', perform)).rejects.toThrow('relaunch failed');
    expect(performed).toBe(1);
  });

  it('refuses one request id presented with two different targets, and performs neither migration', async () => {
    const guard = new MigrationReplayGuard(retainAll);
    let performed = 0;
    const perform = async () => {
      performed += 1;
      return view('codex-auto-atomi');
    };

    await guard.run(key('r1'), 'target-a', perform);
    await expect(guard.run(key('r1'), 'target-b', perform)).rejects.toBeInstanceOf(MigrationReplayMismatchError);
    expect(performed).toBe(1);

    // A mismatch against an entry that is still RUNNING is refused the same way.
    const gate = deferred();
    const running = guard.run(key('r2'), 'target-a', () => gate.promise);
    await expect(guard.run(key('r2'), 'target-b', perform)).rejects.toThrow('was already used for a different');
    gate.settle(view('codex-auto-atomi'));
    await running;
    expect(performed).toBe(1);
  });

  it('keeps distinct request ids as distinct migrations', async () => {
    const guard = new MigrationReplayGuard(retainAll);
    let performed = 0;
    const perform = async () => {
      performed += 1;
      return view(`agent-${performed}`);
    };

    expect((await guard.run(key('r1'), 'target-a', perform)).config.agent).toBe('agent-1');
    expect((await guard.run(key('r2'), 'target-a', perform)).config.agent).toBe('agent-2');
    // Same request id, different session: also a distinct migration.
    expect((await guard.run(key('r1', 'session-b'), 'target-a', perform)).config.agent).toBe('agent-3');
    expect(performed).toBe(3);
  });

  it('bounds the settled ledger and forgets the oldest outcome first', async () => {
    const guard = new MigrationReplayGuard(retainAll, 2);
    let performed = 0;
    const perform = async () => {
      performed += 1;
      return view(`agent-${performed}`);
    };

    await guard.run(key('r1'), 'target-a', perform);
    await guard.run(key('r2'), 'target-a', perform);
    await guard.run(key('r3'), 'target-a', perform);
    expect(performed).toBe(3);

    // r1 was evicted, so it is performed afresh; r3 is still remembered.
    expect((await guard.run(key('r1'), 'target-a', perform)).config.agent).toBe('agent-4');
    expect((await guard.run(key('r3'), 'target-a', perform)).config.agent).toBe('agent-3');
    expect(performed).toBe(4);
  });

  it('never evicts a running migration, even when several are in flight over capacity', async () => {
    const guard = new MigrationReplayGuard(retainAll, 1);
    const gates = [deferred(), deferred(), deferred()];
    let performed = 0;
    const perform = (index: number) => () => {
      performed += 1;
      const gate = gates[index];
      if (gate === undefined) throw new Error(`missing gate ${index}`);
      return gate.promise;
    };

    const runs = [
      guard.run(key('r1'), 'target-a', perform(0)),
      guard.run(key('r2'), 'target-a', perform(1)),
      guard.run(key('r3'), 'target-a', perform(2)),
    ];
    expect(performed).toBe(3);

    // All three are over a capacity of one, and every one of them must still recognise its replay
    // rather than launch a second relaunch.
    const replays = [
      guard.run(key('r1'), 'target-a', perform(0)),
      guard.run(key('r2'), 'target-a', perform(1)),
      guard.run(key('r3'), 'target-a', perform(2)),
    ];
    expect(performed).toBe(3);

    gates.forEach((gate, index) => {
      gate.settle(view(`agent-${index}`));
    });
    expect((await Promise.all(runs)).map(v => v.config.agent)).toEqual(['agent-0', 'agent-1', 'agent-2']);
    expect((await Promise.all(replays)).map(v => v.config.agent)).toEqual(['agent-0', 'agent-1', 'agent-2']);
    expect(performed).toBe(3);
  });

  it('treats a non-positive capacity as one retained outcome', async () => {
    const guard = new MigrationReplayGuard(retainAll, 0);
    let performed = 0;
    const perform = async () => {
      performed += 1;
      return view(`agent-${performed}`);
    };

    await guard.run(key('r1'), 'target-a', perform);
    expect((await guard.run(key('r1'), 'target-a', perform)).config.agent).toBe('agent-1');
    expect(performed).toBe(1);
  });

  it('publishes a default capacity', () => {
    expect(MIGRATION_REPLAY_CAPACITY).toBeGreaterThan(0);
  });
});
