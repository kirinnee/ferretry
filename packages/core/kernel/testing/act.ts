import type { Result } from '@ferretry/std';
import { err, ok } from '@ferretry/std';
import type { ActPermit, ActRunner, Actor, HoldRefusal, MintedIds, OpaqueId, TargetRef } from '../contract/act.ts';
import { closeAck, isOp, showsSomething } from '../contract/act.ts';
import type { InputHolds } from '../contract/bound.ts';

/** Ids the test host minted for a tool to answer with (§4.7): only these pass `closeAck`. */
export class TestMintedIds implements MintedIds {
  private readonly ids = new Map<unknown, OpaqueId>();
  private next = 1;

  mint(raw: unknown = `id-${this.next}`): OpaqueId {
    const existing = this.ids.get(raw);
    if (existing !== undefined) return existing;
    const id = `opaque-${this.next++}` as OpaqueId;
    this.ids.set(raw, id);
    this.ids.set(id, id);
    return id;
  }
  has(id: unknown): boolean {
    return this.ids.has(id);
  }
  get(id: unknown): OpaqueId {
    const found = this.ids.get(id);
    if (found === undefined) throw new Error('unminted id');
    return found;
  }
}

/** One recorded act, for assertions. */
export interface ActRecord {
  readonly target: TargetRef;
  readonly op: string;
  readonly actor: Actor;
  readonly outcome: 'ran' | HoldRefusal;
}

/**
 * The act runner the test host binds as `kernel.act` (§4.7), with the kernel's rules: one queue per target; inside
 * it, immediately before `fn`, `InputHolds.decide(target, op, actor)`; no holds bound or a throwing decide fails
 * closed (`holds_unavailable`); a write-only op's result goes through `closeAck` and nothing else.
 */
export function testActRunner(options: {
  readonly holds: () => InputHolds | undefined;
  readonly actor: () => Actor;
  readonly minted: MintedIds;
  readonly record?: (entry: ActRecord) => void;
}): ActRunner {
  const queues = new Map<string, Promise<unknown>>();
  const runner = async <O extends Parameters<ActRunner>[1]>(
    target: TargetRef,
    op: O,
    fn: (permit: ActPermit) => Promise<unknown>,
  ): Promise<Result<unknown, HoldRefusal>> => {
    const actor = options.actor();
    if (!isOp(op)) return err({ refused: 'unknown_op' });
    const key = `${target.kind}\u0000${target.key}`;
    const run = async (): Promise<Result<unknown, HoldRefusal>> => {
      const holds = options.holds();
      let answer: ReturnType<InputHolds['decide']>;
      try {
        if (holds === undefined) throw new Error('no InputHolds bound');
        answer = holds.decide(target, op, actor);
      } catch {
        answer = { refused: 'holds_unavailable' };
      }
      if (typeof answer === 'object') {
        options.record?.({ target, op, actor, outcome: answer });
        return err(answer);
      }
      options.record?.({ target, op, actor, outcome: 'ran' });
      const raw = await fn({ answer, actor });
      return ok(showsSomething(op) ? raw : closeAck(raw, options.minted));
    };
    const queued = (queues.get(key) ?? Promise.resolve()).then(run, run);
    queues.set(key, queued.catch(() => undefined));
    return queued;
  };
  return runner as ActRunner;
}
