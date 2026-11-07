/**
 * WHERE A TURN ENDS, for the `turn.ended` hook (§3.5).
 *
 * A ferret that was working and is now idle completed a round; one that was working and is now stopped failed it; a
 * round the owner interrupted ends as `interrupted` whichever way the ferret then settles. The only memory held is the
 * previous phase per ferret and when its round began: a restart costs at most one missed boundary, never a wrong one.
 *
 * What feeds it is Ferrets' `ferret.changed`: every write of a ferret's state is one look, so no round is missed
 * between two polls. The transcript and pane evidence of the full turn watcher (`./service.ts`) feeds the same
 * {@link TurnBoundaries.look} when its ports exist.
 */
export type TurnPhase = 'starting' | 'working' | 'idle' | 'stopped';

export interface TurnBoundary {
  readonly ferret: string;
  /** The round's own name: the instant it began, so one round is one turn however often it is looked at. */
  readonly turn: string;
  readonly outcome: 'completed' | 'interrupted' | 'failed';
  readonly endedAt: string;
}

interface Held {
  readonly phase: TurnPhase;
  /** When the current round began; set while `phase` is `working`. */
  readonly began: string | undefined;
}

export class TurnBoundaries {
  readonly #held = new Map<string, Held>();
  readonly #interrupted = new Set<string>();

  constructor(private readonly emit: (boundary: TurnBoundary) => void) {}

  /** The owner interrupted this ferret's round; however it settles, it ends as interrupted. */
  markInterrupted(ferret: string): void {
    this.#interrupted.add(ferret);
  }

  /** One look at a ferret's phase. Emits when a round that was working has ended. */
  look(ferret: string, phase: TurnPhase, at: string): void {
    const before = this.#held.get(ferret);
    if (phase === 'working') {
      this.#held.set(ferret, { phase, began: before?.phase === 'working' ? before.began : at });
      return;
    }
    if (before?.phase === 'working' && before.began !== undefined && (phase === 'idle' || phase === 'stopped')) {
      const outcome = this.#interrupted.has(ferret) ? 'interrupted' : phase === 'idle' ? 'completed' : 'failed';
      this.emit({ ferret, turn: before.began, outcome, endedAt: at });
    }
    this.#interrupted.delete(ferret);
    this.#held.set(ferret, { phase, began: undefined });
  }

  /** The round a ferret is in the middle of, named as `turn.ended` will name it. */
  current(ferret: string): string | undefined {
    const held = this.#held.get(ferret);
    return held?.phase === 'working' ? held.began : undefined;
  }

  /** Forgets a ferret that is gone. */
  forget(ferret: string): void {
    this.#held.delete(ferret);
    this.#interrupted.delete(ferret);
  }
}
