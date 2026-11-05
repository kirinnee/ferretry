/**
 * THE FERRET'S SIDE OF A LIVE TURN, read from the session the page already holds — no new route.
 *
 * After a send, Live waits for `turnState` (derived by the daemon from the transcript and the pane,
 * never from "a message was sent") to say the turn is over. The trap is a stale `your-turn` from
 * BEFORE the send, still on the session for the moment before it flips to `working`. So a finished
 * state only counts once the turn has been seen to move: `working` was observed since the watch began,
 * or `turnStateAt` changed from what it was then. Both are the daemon's own words about itself; no
 * browser clock is compared with the daemon's, so clock skew cannot read a reply early or late.
 *
 * A daemon that predates `turnState` never says anything: Live keeps showing Working, and the person
 * ends it or answers by hand (docs/voice.md › Live voice › What is not built).
 */

import type { ReplyFeedPort, ReplySignal } from './ports.ts';

type ReplyTurnState = 'working' | 'your-turn' | 'needs-input';

/** The few things Live reads from the session view. */
export interface ReplySnapshot {
  readonly turnState: ReplyTurnState | undefined;
  readonly turnStateAt: string | undefined;
  /** The session's lifecycle status; a finished one ends Live. */
  readonly status: string;
}

export interface ReplySource {
  /** The session now; `null` when it is gone. */
  current(): ReplySnapshot | null;
  /** Called whenever the session view changes; returns the unsubscribe. */
  subscribe(onChange: () => void): () => void;
}

const FINISHED = new Set(['completed', 'failed', 'stopped']);

export function sessionReplyFeed(source: ReplySource): ReplyFeedPort {
  return {
    watch: onSignal => {
      const baseline = source.current();
      const baselineAt = baseline?.turnStateAt;
      let seenWorking = baseline?.turnState === 'working';
      let last: ReplySignal['kind'] | null = null;
      const emit = (signal: ReplySignal): void => {
        if (signal.kind === last) return;
        last = signal.kind;
        onSignal(signal);
      };
      const evaluate = (): void => {
        const now = source.current();
        if (now === null || FINISHED.has(now.status)) return emit({ kind: 'ended' });
        if (now.turnState === 'working') {
          seenWorking = true;
          return emit({ kind: 'working' });
        }
        const moved = seenWorking || now.turnStateAt !== baselineAt;
        if (!moved) return;
        if (now.turnState === 'your-turn') return emit({ kind: 'done' });
        if (now.turnState === 'needs-input') return emit({ kind: 'needs-input' });
      };
      const unsubscribe = source.subscribe(evaluate);
      evaluate();
      return unsubscribe;
    },
  };
}
