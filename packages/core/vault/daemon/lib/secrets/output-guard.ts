/**
 * The kernel-bound `OutputGuard` (§7.3): the non-secret state the final check reads.
 *
 * A body that may show pane, page or vault-derived text is built inside one `Redaction.read`, stamped here, and the
 * dispatcher's `late` asks `stillShowable` as the last synchronous step before bytes leave (I74). It answers from a
 * generation counter alone, with no await and no vault: false when a hold began on one of the stamp's targets (or
 * its generation otherwise moved) after the stamp was taken.
 *
 * The holds themselves are the input half's (`InputHolds`, vault-b): it calls {@link HoldRegistry.moved} on the same
 * serialization chain as every hold change, so the guard and the holds never disagree about order.
 */

import type { GuardStamp, OutputGuard, TargetRef } from '@ferretry/kernel/contract';

const keyOf = (target: TargetRef): string => `${target.kind}\u0000${target.key}`;

export class HoldRegistry implements OutputGuard {
  #generation = 0;
  /** The generation at which each target last moved. A target never moved is absent (moved at 0). */
  readonly #movedAt = new Map<string, number>();

  /** A hold began or ended on `target`, or its permit generation otherwise moved. Answers the new generation. */
  moved(target: TargetRef): number {
    this.#generation += 1;
    this.#movedAt.set(keyOf(target), this.#generation);
    return this.#generation;
  }

  generation(): number {
    return this.#generation;
  }

  stamp(targets: readonly TargetRef[] = []): GuardStamp {
    return { generation: this.#generation, targets: [...targets] };
  }

  stillShowable(stamp: GuardStamp): boolean {
    try {
      return stamp.targets.every(target => (this.#movedAt.get(keyOf(target)) ?? 0) <= stamp.generation);
    } catch {
      // A throw is read as false: withheld, never shown on a doubt.
      return false;
    }
  }
}
