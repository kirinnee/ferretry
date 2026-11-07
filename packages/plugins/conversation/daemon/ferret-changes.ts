import type { FerretChangedPayload, FerretStoppingPayload } from '@ferretry/core-ferrets/contract';
import type { TurnPhase } from './turns/lib/boundaries.ts';

/** What Conversation does when Ferrets says a ferret changed. */
export interface FerretChangeFollowers {
  /** Zeroes and forgets every unlocked attachment plaintext the ferret holds. */
  readonly release: (ferret: string) => void;
  /** One look at the ferret's phase, for `turn.ended`. */
  readonly look: (ferret: string, phase: TurnPhase) => void;
  /** The ferret is gone: nothing is held for it any more. */
  readonly forget: (ferret: string) => void;
  readonly warn: (message: string) => void;
}

/**
 * Conversation's `ferret.stopping` taker: a stop is being attempted, so the ferret's decrypted attachments are zeroed
 * NOW, before the stop can fail (today's `releasingAttachmentsOnStop` released in a `finally` around the stop, whether
 * or not it succeeded). Ferrets says it before a missing harness or runner refuses the stop and before the harness
 * stop runs, so a stop that throws still leaves no plaintext behind; `ferret.changed` releases again on a stop that
 * worked, which is harmless. A release that throws is not swallowed: the kernel logs a failing observer, and the stop
 * itself goes on.
 */
export function followFerretStopping(
  followers: Pick<FerretChangeFollowers, 'release'>,
): (payload: FerretStoppingPayload) => void {
  return ({ ferret }) => followers.release(ferret);
}

/**
 * Conversation's `ferret.changed` taker. A ferret that stopped, or was removed, has its decrypted attachments zeroed
 * at once (today's `releasingAttachmentsOnStop`), and that runs FIRST and whatever else here fails: a half-stopped
 * ferret holding a decrypted document is the case worth failing closed for. Every change that carries a phase is a
 * look for the turn boundaries, so a round that goes working → idle between two moments is still one `turn.ended`.
 */
export function followFerretChanges(followers: FerretChangeFollowers): (payload: FerretChangedPayload) => void {
  return payload => {
    const { ferret, state, change } = payload;
    try {
      if (change === 'stopped' || change === 'removed' || state === 'stopped') followers.release(ferret);
    } finally {
      try {
        if (change === 'removed') followers.forget(ferret);
        else followers.look(ferret, state);
      } catch (error) {
        followers.warn(`conversation could not follow a turn of ${ferret}: ${String(error)}`);
      }
    }
  };
}
