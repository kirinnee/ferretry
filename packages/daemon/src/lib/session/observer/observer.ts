/**
 * THE SESSION OBSERVER: everything the daemon derives about one live session, as one pure fold.
 *
 * Stage 3 of the event-driven daemon (`docs/design/session-workers.md`) moves each live session's
 * observation off the main thread. This is the part that moves: turn state, the open structured question
 * and the observed runtime, the Warden's liveness sample and the send-evidence fold — the derivations
 * the turn watcher, the monitor's question pass, the liveness monitor and the send tracker each made
 * over their own reads. Here they are values in and values out:
 *
 *   step(state, input) → { state, patches, samples }
 *
 * WHAT IT IS NOT. It reads nothing and writes nothing. A host gathers each look through its own ports
 * and hands the patches to the ONE writer, the main thread's `SessionObservationApplier`, which runs them
 * through the same locked storage path as always — so the session lock, the index, the journal and its
 * listeners stay exactly where they were. Nothing in this directory imports zod or a value of
 * `@ferretry/protocol`: a host on a lean worker thread must be able to load it (design §3.4).
 *
 * ORDER (#689). Inside one step the question part runs before the turn part and its patch comes first,
 * so a host that applies one session's patches in order keeps the invariant the boot order restored:
 * question reprojection lands before turn state is written over the same document.
 *
 * THE ONE SANCTIONED SECOND PRODUCER of `turnState` is the send repository, which records `working` on a
 * send so a page flips before the next look. The writer's compare-and-set on `from` makes the two
 * commute; the observer learns the new value from the facts that follow the write.
 */

import type { LivenessSample } from '../../warden/liveness.ts';
import type { TurnObservation } from '../turn/policy.ts';
import { type LivenessLook, livenessSampleOf, type TextDigest } from './liveness.ts';
import { type QuestionLook, type QuestionPatch, stepQuestion } from './question.ts';
import { stepTurn, type TurnFacts, type TurnLook, type TurnStateChange } from './turn.ts';

/**
 * What an observer remembers of one session between looks. Frozen; every step answers a new one.
 *
 * Nothing in it outlives the daemon: a restarted daemon re-derives from the transcript and the pane, and
 * losing `turn` costs one extra look before an unconfirmed `your-turn` is recorded — never a wrong answer.
 */
export interface ObserverState {
  /** The session's durable fields, as the main thread last told them. */
  readonly facts?: TurnFacts | undefined;
  /** The previous turn observation, for the two-frame confirmation `settleTurnState` asks for. */
  readonly turn?: TurnObservation | undefined;
}

/** The state of a session nothing has been told or seen about yet. */
export const INITIAL_OBSERVER_STATE: ObserverState = Object.freeze({});

/** The main thread wrote the session's document: here are the fields the observer decides from. */
export interface ObserverFactsInput {
  readonly kind: 'facts';
  readonly facts: TurnFacts;
}

/** One look at a session. Each part present is decided; a part absent is left alone this step. */
export interface ObserverLookInput {
  readonly kind: 'look';
  /** The facts the look was taken against, when the host read them with it. */
  readonly facts?: TurnFacts | undefined;
  readonly question?: QuestionLook | undefined;
  /** The turn part runs when present; `look` is `undefined` for a session that is not live. */
  readonly turn?: { readonly look: TurnLook | undefined } | undefined;
  readonly liveness?: LivenessLook | undefined;
}

export type ObserverInput = ObserverFactsInput | ObserverLookInput;

/** A turn change for the writer to compare-and-set on `from`. */
export interface TurnPatch {
  readonly kind: 'turn';
  readonly change: TurnStateChange;
}

/** A change for the ONE writer. Plain data: it crosses a thread boundary as it is. */
export type ObserverPatch = QuestionPatch | TurnPatch;

export interface ObserverStep {
  readonly state: ObserverState;
  /** In the order they must be applied: a question patch before a turn patch. */
  readonly patches: readonly ObserverPatch[];
  readonly samples: readonly LivenessSample[];
}

/** A stateless service: every changing value comes in through `step` and goes out through its answer. */
export class SessionObserver {
  constructor(private readonly digest: TextDigest) {}

  step(state: ObserverState, input: ObserverInput): ObserverStep {
    if (input.kind === 'facts') return freeze({ ...state, facts: input.facts }, [], []);
    const facts = input.facts ?? state.facts;
    const patches: ObserverPatch[] = [];
    const question = input.question === undefined ? undefined : stepQuestion(input.question);
    if (question !== undefined) patches.push(question);
    let turn = state.turn;
    if (input.turn !== undefined && facts !== undefined) {
      const step = stepTurn(facts, state.turn, input.turn.look);
      turn = step.observation;
      if (step.change !== undefined) patches.push({ kind: 'turn', change: step.change });
    }
    const samples = input.liveness === undefined ? [] : [livenessSampleOf(input.liveness, this.digest)];
    return freeze(
      { ...(facts === undefined ? {} : { facts }), ...(turn === undefined ? {} : { turn }) },
      patches,
      samples,
    );
  }
}

function freeze(
  state: ObserverState,
  patches: readonly ObserverPatch[],
  samples: readonly LivenessSample[],
): ObserverStep {
  return Object.freeze({
    state: Object.freeze(state),
    patches: Object.freeze(patches),
    samples: Object.freeze(samples),
  });
}
