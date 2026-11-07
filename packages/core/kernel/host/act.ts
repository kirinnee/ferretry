import type { Result } from '@ferretry/std';
import { err, ok } from '@ferretry/std';
import type {
  ActPermit,
  ActRunner,
  HoldDecision,
  MintedIds,
  OpaqueId,
  Op,
  ResultOf,
  TargetRef,
} from '../contract/act.ts';
import { closeAck, isOp, showsSomething } from '../contract/act.ts';
import type { InputHolds } from '../contract/bound.ts';
import { currentActor } from './call-scope.ts';

/**
 * The kernel's id factory and registry (§4.7): an `OpaqueId` exists only if the kernel minted it, so a write-only
 * act cannot smuggle a URL or title out as an "id". `get` hands back the kernel's own copy.
 */
export class MintedIdRegistry implements MintedIds {
  private readonly ids = new Map<string, OpaqueId>();
  private counter = 0;

  constructor(private readonly random: () => string) {}

  mint(prefix: string): OpaqueId {
    this.counter += 1;
    const id = `${prefix}${this.counter.toString(36)}${this.random()}` as OpaqueId;
    this.ids.set(id, id);
    return id;
  }

  has(id: unknown): boolean {
    return typeof id === 'string' && this.ids.has(id);
  }

  get(id: unknown): OpaqueId {
    const own = typeof id === 'string' ? this.ids.get(id) : undefined;
    if (own === undefined) throw new TypeError('not a minted id');
    return own;
  }

  forget(id: OpaqueId): void {
    this.ids.delete(id);
  }
}

/** One serial chain per target: the hold is asked inside it, immediately before the act (§4.7, I-rows). */
class TargetQueues {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(target: TargetRef, work: () => Promise<T>): Promise<T> {
    const key = `${target.kind}\u0000${target.key}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

/**
 * `kernel.act` (§4.7, §7.4). Inside the target's queue, synchronously before `fn`: the op is looked up from its RUNTIME
 * value (an unknown op is refused before `fn` runs), the actor is stamped from the call (a plugin cannot choose it),
 * and `InputHolds.decide` answers; a missing provider or a throw fails closed (`holds_unavailable`). A write-only
 * result is closed to a fresh Ack by `closeAck` before anything formats, journals, audits, views or replies with it.
 */
export function createActRunner(holds: () => InputHolds | undefined, minted: MintedIds): ActRunner {
  const queues = new TargetQueues();
  const runner = async <O extends Op>(
    target: TargetRef,
    op: O,
    fn: (permit: ActPermit) => Promise<ResultOf<O>>,
  ): Promise<Result<ResultOf<O>, { readonly refused: import('../contract/act.ts').RefusalCode }>> => {
    const runtimeOp: unknown = op;
    if (!isOp(runtimeOp)) return err({ refused: 'unknown_op' });
    const actor = currentActor();
    return await queues.run(target, async () => {
      const bound = holds();
      let decision: HoldDecision;
      if (bound === undefined) return err({ refused: 'holds_unavailable' });
      try {
        // The fresh read, then the decision with NO await between them: nothing can change the target in the gap.
        if (bound.prepare !== undefined) await bound.prepare(target, runtimeOp, actor);
        decision = bound.decide(target, runtimeOp, actor);
      } catch {
        return err({ refused: 'holds_unavailable' });
      }
      if (decision !== 'allow' && decision !== 'allow-masked') {
        const refused =
          decision !== null && typeof decision === 'object' && typeof decision.refused === 'string'
            ? decision.refused
            : 'holds_unavailable';
        return err({ refused });
      }
      const raw: unknown = await fn(Object.freeze({ answer: decision, actor }));
      const result = showsSomething(runtimeOp) ? raw : closeAck(raw, minted);
      if (showsSomething(runtimeOp) || (result as { status: string }).status === 'done') {
        try {
          bound.observed?.(target, runtimeOp, actor);
        } catch {
          // the act already happened; a failing observer cannot undo it or fail the caller
        }
      }
      return ok(result as ResultOf<O>);
    });
  };
  return runner as ActRunner;
}
