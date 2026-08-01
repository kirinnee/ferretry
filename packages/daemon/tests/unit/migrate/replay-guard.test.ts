import type { SessionView } from '@ferretry/protocol';
import { describe, expect, it } from 'bun:test';
import {
  MIGRATION_REPLAY_MAX_ENTRIES,
  MigrationReplayCapacityError,
  MigrationReplayGuard,
  MigrationReplayMismatchError,
  migrationReplayKey,
} from '../../../src/lib/migrate/replay-guard.ts';

/** Stands in for the taxonomy's `failed`: a failure raised past the point of no return. */
class CommittedError extends Error {}

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

  it('still replays an early success and an early committed failure after very many later migrations', async () => {
    // THE REGRESSION THIS PINS. The guard used to keep a bounded 64-entry history, so 64 later
    // migrations discarded an earlier receipt and the next request carrying that earlier id found a
    // clean slate and relaunched a session that had already been relaunched. The bound was counted in
    // MIGRATIONS, not seconds, so no retry window was short enough to be safe. Nothing settled may be
    // forgotten while the process lives, and 500 unrelated migrations is well past any bound a future
    // change might reintroduce.
    const guard = new MigrationReplayGuard(committedFailure => committedFailure instanceof CommittedError);
    let performed = 0;
    const succeed = async () => {
      performed += 1;
      return view(`agent-${performed}`);
    };
    const failAfterDestruction = async (): Promise<SessionView> => {
      performed += 1;
      throw new CommittedError('the relaunch failed after the pane was replaced');
    };

    // Two early receipts: one success, one failure that happened past the point of no return.
    const early = await guard.run(key('early-success'), 'target-a', succeed);
    expect(early.config.agent).toBe('agent-1');
    await expect(guard.run(key('early-failure'), 'target-a', failAfterDestruction)).rejects.toThrow(
      'the relaunch failed after the pane was replaced',
    );
    expect(performed).toBe(2);

    // Heavy unrelated traffic, far more than any plausible capacity.
    for (let index = 0; index < 500; index += 1) await guard.run(key(`bulk-${index}`), 'target-a', succeed);
    expect(performed).toBe(502);

    // Both early receipts must still answer, and neither may run its destruction a second time.
    expect((await guard.run(key('early-success'), 'target-a', succeed)).config.agent).toBe('agent-1');
    await expect(guard.run(key('early-failure'), 'target-a', failAfterDestruction)).rejects.toThrow(
      'the relaunch failed after the pane was replaced',
    );
    expect(performed).toBe(502);

    // And a receipt from the middle of the traffic is intact too, not just the endpoints.
    expect((await guard.run(key('bulk-250'), 'target-a', succeed)).config.agent).toBe('agent-253');
    expect(performed).toBe(502);
  });

  it('keeps every concurrent migration recognisable, however many are in flight at once', async () => {
    // The in-flight map must hold every running migration: a replay that failed to find its original
    // would start a second relaunch.
    const guard = new MigrationReplayGuard(retainAll);
    const gates = Array.from({ length: 24 }, () => deferred());
    let performed = 0;
    const perform = (index: number) => () => {
      performed += 1;
      const gate = gates[index];
      if (gate === undefined) throw new Error(`missing gate ${index}`);
      return gate.promise;
    };

    const runs = gates.map((_gate, index) => guard.run(key(`r${index}`), 'target-a', perform(index)));
    const replays = gates.map((_gate, index) => guard.run(key(`r${index}`), 'target-a', perform(index)));
    expect(performed).toBe(gates.length);

    gates.forEach((gate, index) => {
      gate.settle(view(`agent-${index}`));
    });
    const expected = gates.map((_gate, index) => `agent-${index}`);
    expect((await Promise.all(runs)).map(v => v.config.agent)).toEqual(expected);
    expect((await Promise.all(replays)).map(v => v.config.agent)).toEqual(expected);
    expect(performed).toBe(gates.length);
  });
});

/**
 * Admission control: how the ledger stays bounded without ever forgetting a receipt.
 *
 * A caller minting fresh request ids forever would otherwise grow the map without limit. The answer is
 * to refuse NEW work rather than discard OLD receipts, because refusing destroys nothing and
 * discarding re-authorizes a destructive relaunch.
 */
describe('MigrationReplayGuard admission', () => {
  it('refuses a new identity at capacity WITHOUT performing it', async () => {
    const guard = new MigrationReplayGuard(retainAll, 2);
    let performed = 0;
    const perform = async () => {
      performed += 1;
      return view(`agent-${performed}`);
    };

    await guard.run(key('r1'), 'target-a', perform);
    await guard.run(key('r2'), 'target-a', perform);
    expect(guard.size).toBe(2);
    expect(performed).toBe(2);

    // The third is turned away, and the destructive thunk is never invoked — that is the whole point
    // of checking admission before `perform`.
    await expect(guard.run(key('r3'), 'target-a', perform)).rejects.toBeInstanceOf(MigrationReplayCapacityError);
    expect(performed).toBe(2);
    expect(guard.size).toBe(2);

    // Repeated attempts stay refused and stay harmless.
    await expect(guard.run(key('r4'), 'target-a', perform)).rejects.toThrow('will not admit another');
    expect(performed).toBe(2);
  });

  it('still serves every existing success and committed failure while full', async () => {
    // A memory limit that stopped answering for migrations already performed would BE the
    // re-destruction hazard it was added to prevent.
    const guard = new MigrationReplayGuard(committed => committed instanceof CommittedError, 2);
    let performed = 0;
    const succeed = async () => {
      performed += 1;
      return view(`agent-${performed}`);
    };
    const failAfterDestruction = async (): Promise<SessionView> => {
      performed += 1;
      throw new CommittedError('the relaunch failed after the pane was replaced');
    };

    const success = await guard.run(key('done'), 'target-a', succeed);
    await expect(guard.run(key('broken'), 'target-a', failAfterDestruction)).rejects.toThrow('after the pane');
    expect(guard.size).toBe(2);

    // Full: new work is refused.
    await expect(guard.run(key('fresh'), 'target-a', succeed)).rejects.toBeInstanceOf(MigrationReplayCapacityError);

    // ...and both receipts still answer, without re-performing anything.
    expect((await guard.run(key('done'), 'target-a', succeed)).config.agent).toBe(success.config.agent);
    await expect(guard.run(key('broken'), 'target-a', failAfterDestruction)).rejects.toThrow('after the pane');
    expect(performed).toBe(2);

    // A mismatched target on a held id is still the mismatch answer, not the capacity answer: the
    // caller needs to know its id names another migration, and a full ledger does not change that.
    await expect(guard.run(key('done'), 'target-b', succeed)).rejects.toBeInstanceOf(MigrationReplayMismatchError);
    expect(performed).toBe(2);
  });

  it('serves an in-flight replay while full, rather than refusing it as new work', async () => {
    const guard = new MigrationReplayGuard(retainAll, 1);
    const gate = deferred();
    let performed = 0;
    const perform = () => {
      performed += 1;
      return gate.promise;
    };

    const first = guard.run(key('r1'), 'target-a', perform);
    expect(guard.size).toBe(1);
    // The slot is taken by a RUNNING migration, so a different id is refused...
    await expect(guard.run(key('r2'), 'target-a', perform)).rejects.toBeInstanceOf(MigrationReplayCapacityError);
    // ...while the retry of the running one joins it.
    const replay = guard.run(key('r1'), 'target-a', perform);
    expect(performed).toBe(1);

    gate.settle(view('codex-auto-atomi'));
    expect((await first).config.agent).toBe('codex-auto-atomi');
    expect((await replay).config.agent).toBe('codex-auto-atomi');
    expect(performed).toBe(1);
  });

  it('frees admission when a migration is refused before it touches the pane', async () => {
    // Pre-destructive refusals release their slot, which is why a fleet that trips the preflight all
    // day long consumes no admission at all and can never reach the cap by refusals alone.
    const guard = new MigrationReplayGuard(retainNone, 1);
    let performed = 0;
    const refuse = async (): Promise<SessionView> => {
      performed += 1;
      throw new Error('in-flight work refuses this migration');
    };
    const succeed = async () => {
      performed += 1;
      return view(`agent-${performed}`);
    };

    await expect(guard.run(key('refused'), 'target-a', refuse)).rejects.toThrow('in-flight work refuses');
    expect(guard.size).toBe(0);

    // The freed slot admits genuinely new work...
    expect((await guard.run(key('next'), 'target-a', succeed)).config.agent).toBe('agent-2');
    expect(guard.size).toBe(1);

    // ...and now that the slot holds a committed receipt, the cap bites again.
    await expect(guard.run(key('another'), 'target-a', succeed)).rejects.toBeInstanceOf(MigrationReplayCapacityError);
    expect(performed).toBe(2);
  });

  it('cannot overshoot the cap when many callers arrive at once', async () => {
    // Admission is checked and the slot reserved in one synchronous step, so concurrent callers cannot
    // both pass one free slot.
    const guard = new MigrationReplayGuard(retainAll, 4);
    const gates = Array.from({ length: 32 }, () => deferred());
    let performed = 0;
    const perform = (index: number) => () => {
      performed += 1;
      const gate = gates[index];
      if (gate === undefined) throw new Error(`missing gate ${index}`);
      return gate.promise;
    };

    const attempts = gates.map((_gate, index) =>
      guard.run(key(`r${index}`), 'target-a', perform(index)).then(
        () => 'admitted' as const,
        error => (error instanceof MigrationReplayCapacityError ? ('refused' as const) : ('other' as const)),
      ),
    );

    // Exactly four thunks ran, in the same tick, before anything settled.
    expect(performed).toBe(4);
    expect(guard.size).toBe(4);

    gates.forEach((gate, index) => {
      gate.settle(view(`agent-${index}`));
    });
    const outcomes = await Promise.all(attempts);
    expect(outcomes.filter(outcome => outcome === 'admitted')).toHaveLength(4);
    expect(outcomes.filter(outcome => outcome === 'refused')).toHaveLength(28);
    expect(outcomes.filter(outcome => outcome === 'other')).toHaveLength(0);
    expect(guard.size).toBe(4);
    expect(performed).toBe(4);
  });

  it('treats a non-positive cap as one admission, and publishes a human-scale production default', async () => {
    const guard = new MigrationReplayGuard(retainAll, 0);
    let performed = 0;
    const perform = async () => {
      performed += 1;
      return view(`agent-${performed}`);
    };

    await guard.run(key('r1'), 'target-a', perform);
    await expect(guard.run(key('r2'), 'target-a', perform)).rejects.toBeInstanceOf(MigrationReplayCapacityError);
    expect(performed).toBe(1);

    // Large enough that deliberate human migrations never reach it; small enough that the ledger is
    // megabytes rather than a heap.
    expect(MIGRATION_REPLAY_MAX_ENTRIES).toBe(4096);
  });

  it('defaults to the production cap when none is given', async () => {
    const guard = new MigrationReplayGuard(retainAll);
    let performed = 0;
    const perform = async () => {
      performed += 1;
      return view(`agent-${performed}`);
    };

    for (let index = 0; index < 60; index += 1) await guard.run(key(`r${index}`), 'target-a', perform);
    expect(guard.size).toBe(60);
    expect(performed).toBe(60);
  });
});
