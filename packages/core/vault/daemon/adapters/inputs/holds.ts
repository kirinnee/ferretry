import {
  type Actor,
  type HoldDecision,
  type InputHolds,
  OP_EFFECTS,
  type Op,
  type RevealGrant,
  type TargetRef,
} from '@ferretry/kernel/contract';
import type { QuarantineRegistry } from '../../lib/inputs/quarantine.ts';
import type { InputRequestService } from '../../lib/inputs/service.ts';

/**
 * `InputHolds` (§4.7) over today's quarantine registry and pending cards: the rules of the decide table, each as
 * input-requests.md keeps it. Synchronous, as the act runner asks it inside the target's queue. When several rows
 * match, the most restrictive answer wins (refused over allowed).
 *
 * - A pending card with any non-`code` field refuses every ferret op that writes; a card of only codes lets the
 *   ferret's `keys` and `type` through (I32).
 * - A terminal in quarantine refuses every op that reads, for the ferret AND the owner's tools; the ferret can still
 *   send keys; the owner's viewer sees it only with an unexpired reveal for that target (I72, I77).
 * - A page hold refuses every op that pictures, and every op that reads. Today's "read again once the page moved to
 *   another document" asks the browser for the document, which a synchronous decision cannot; it is refused instead
 *   (stricter), a declared gap until the page's document reaches the decision.
 *
 * A `TargetRef` names no ferret, so every session holding something is asked: a key two ferrets share is held for
 * both, the strict direction.
 */
export class InputHoldsOverService implements InputHolds {
  constructor(
    private readonly service: Pick<InputRequestService, 'openSessions' | 'pendingOn' | 'pageHeld'>,
    private readonly quarantine: Pick<QuarantineRegistry, 'sessions' | 'until'>,
    private readonly nowMs: () => number,
  ) {}

  decide(target: TargetRef, op: Op, actor: Actor, reveal?: RevealGrant): HoldDecision {
    // The owner's own delivery is what the holds protect; nothing holds it.
    if (actor === 'owner-input') return 'allow';
    const effects: readonly string[] = OP_EFFECTS[op];
    const reads = effects.includes('reads');
    const writes = effects.includes('writes');
    const pictures = effects.includes('pictures');
    const ferret = actor === 'ferret' || actor === 'warden';
    const sessions = new Set([...this.quarantine.sessions(), ...this.service.openSessions()]);
    for (const session of sessions) {
      if (ferret && writes) {
        const typing = op === 'keys' || op === 'type';
        if (this.service.pendingOn(session, target, { typing }) !== undefined) return { refused: 'input_pending' };
      }
      if (target.kind === 'terminal' && (reads || pictures)) {
        if (this.quarantine.until(session, [target.key]) !== undefined && !this.revealed(actor, target, reveal))
          return { refused: 'quarantined' };
      }
      if (target.kind === 'page' && (reads || pictures)) {
        if (this.service.pageHeld(session, [target.key]) !== undefined) return { refused: 'held' };
      }
    }
    return 'allow';
  }

  /** Only the owner's viewer may look anyway, and only under a reveal for this very target that has not run out. */
  private revealed(actor: Actor, target: TargetRef, reveal: RevealGrant | undefined): boolean {
    if (actor !== 'owner-viewer' || reveal === undefined) return false;
    if (reveal.target.kind !== target.kind || reveal.target.key !== target.key) return false;
    return Date.parse(reveal.until) > this.nowMs();
  }
}
