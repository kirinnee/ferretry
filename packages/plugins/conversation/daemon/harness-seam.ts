import type {
  DeliveryOutcome,
  FerretHarness,
  FerretsApi,
  HarnessDeliveryFailure,
  HarnessRefusal,
  PaneNotReadyReason,
  QueueOutcome,
} from '@ferretry/core-ferrets/contract';
import { ApiError, REFUSAL_SENTENCES } from '@ferretry/kernel/contract';
import type { TurnStopped } from './delivery/lib/interrupt.ts';
import { composerOccupiedRefusal, composerUnreadableRefusal } from './delivery/lib/service.ts';
import { SessionSendError } from './delivery/lib/mounts/session-send.ts';
import { tryParseSessionId } from './seams/ferret-id.ts';

/**
 * THE TERMINAL SEAM: what Conversation types into a ferret, and the stop it presses, go through Ferrets' harness seam
 * (`FerretsApi.harness`). Ferrets' runner already acts on the ferret's terminal for every write it makes (Vault's holds
 * apply there), so this file wraps NOTHING in an act of its own: an outer act on that terminal would wait on the inner
 * one and neither would settle.
 *
 * The seam is the one place an answer of the harness becomes Conversation's words, so every route and the port answer a
 * pane that is gone, a hold, a pane that never came to a prompt or a plugin that is off the same way.
 */
export interface TerminalSeam {
  /**
   * Opens the ferret's terminal. Throws before anything can be typed when the ferret is unknown (404) or Ferrets offers
   * no seam (503), so a send records nothing then. It names no caller: sending and interrupting have no target rule
   * (the path names where the message goes, for every caller), so Ferrets' mayTouch is not asked.
   */
  bind(ferret: string): Promise<BoundTerminal>;
}

/**
 * Which of the seam's two actions are live. Ferrets' `deliver` answers a closed taxonomy (nothing typed, or typed and
 * not proven) and its `interrupt` presses the harness's own stop key under the harness's rule, so the daemon wires
 * {@link HARNESS_OPEN}. A closed action answers 503 before anything is opened, typed or kept.
 */
export interface HarnessGate {
  readonly send: boolean;
  readonly interrupt: boolean;
}

/** Both actions live: what the daemon wires (`daemon/index.ts`). */
export const HARNESS_OPEN: HarnessGate = { send: true, interrupt: true };

/** Said by a send while its gate is closed: what is unavailable and why, in the person's words. */
export const SEND_UNAVAILABLE =
  "Sending a message to a ferret from here is not available yet: this machine cannot yet tell safely whether the ferret is busy, waiting at a dialog or holding a draft, so a message could be lost or typed twice. Type it in the ferret's terminal for now.";

/** Said by an interrupt while its gate is closed. */
export const INTERRUPT_UNAVAILABLE =
  "Stopping a ferret's turn from here is not available yet: this machine cannot yet tell safely whether the ferret is working or waiting at its prompt, so a stop could quit the agent instead. Stop it in the ferret's terminal for now.";

/**
 * Said by a send that carries what the seam does not type yet: files, the fyi label (which holds a message to the
 * turn's end), the send-now flag or a reply request. Each would be dropped and the message still reported as sent.
 */
export const SEND_EXTRAS_UNAVAILABLE =
  "Sending files, an fyi message held to the turn's end, the send-now flag or a reply request is not available yet: they would be dropped and the message still reported as sent. Send the message alone (as an action or a blocker), or type it in the ferret's terminal.";

/**
 * ONE FIXED SENTENCE PER REASON a pane never came to a prompt. Nothing of the message was typed, so the same send may
 * go again. Today's answer quoted the runner's message (the terminal session's name, a dialog's prompt line); this
 * answer says only the closed reason and the remedy.
 */
export const NOT_READY_SENTENCES: Readonly<Record<PaneNotReadyReason, string>> = {
  busy: 'the agent never came to a prompt: it is still working on its turn, so nothing was typed; send it again once its turn ends',
  dialog:
    'the agent never came to a prompt: it is waiting at a dialog on its screen, so nothing was typed; answer the prompt on its screen, then send it again',
  exited:
    'the agent never came to a prompt: its terminal has gone, so nothing was typed; revive the ferret, then send it again',
};

/**
 * Said when the message WAS typed and nothing proved it landed. It is never typed again: it may be in the agent's box
 * now, or still on its way there. Retry, Clear and Enter on a send are not served from here yet, so the person is sent
 * to the ferret's terminal.
 */
export const UNCONFIRMED_SENTENCE =
  "the message was typed into the agent's box, but the agent has not shown it there yet, so it was not typed again. It may still appear: check the ferret's terminal before sending it again";

/** Said when the message was typed and stayed in the agent's box after Enter: the agent has not read it. */
export const STRANDED_SENTENCE =
  "the message was typed into the agent's box but stayed there after Enter, so the agent has not read it and it was not typed again. Press Enter on it in the ferret's terminal, or clear it there before sending it again";

/** Said by a stop the harness could not press because the ferret's terminal could not be reached or held still. */
const INTERRUPT_NO_PANE =
  "the ferret's turn could not be stopped: its terminal is gone, or its screen changed under the stop, so nothing was pressed. Try Stop again, or revive the ferret if it has stopped";

/** One ferret's terminal, as Ferrets opened it. */
interface BoundTerminal {
  /**
   * Types one message. Throws the answer the send routes give for a refusal (nothing was typed), {@link Unconfirmed}
   * when it was typed and not proven, or {@link MaybeTyped} when the runner failed in a way nobody could classify.
   */
  deliver(text: string): Promise<DeliveryOutcome>;
  /**
   * Puts one message into the BUSY pane's own queue (Ferrets' `queue`, the runner's `TmuxPaneQueue`), which the
   * harness submits at its next turn boundary. `sendId` is the send row's id: a message long enough to go by file is
   * written to `channel/queued-<sendId>.md`, the name the app reads the send back by, and the pane is typed its pointer.
   * Answers what the pane proved, or `undefined` when NOTHING was typed because the harness answered
   * `plugin_unavailable`: the runner cannot queue, or a long message's file could not be written (no session folder
   * bound, or the write failed). Throws exactly as {@link deliver} does.
   */
  queue(text: string, sendId: string): Promise<QueueOutcome | undefined>;
  /** Presses the harness's stop under its own rule and says what it did. Throws the answer for a refusal. */
  interrupt(): Promise<TurnStopped>;
}

/**
 * The runner failed in a way nobody could classify: keys may already have gone to the pane, so the send's fate is
 * UNCERTAIN rather than absent, and its record must stay (a withdrawal would invite a duplicate retry). `answer` is what
 * the caller is told.
 */
export class MaybeTyped extends Error {
  constructor(readonly answer: Error) {
    super(answer.message);
    this.name = 'MaybeTyped';
  }
}

/**
 * The pane never came to a prompt because the agent is still working on its turn: NOTHING was typed, proven, so the
 * caller may put the message in the harness's own queue instead (today's busy path). `answer` is what the caller is
 * told when it does not.
 */
export class PaneBusy extends Error {
  constructor(readonly answer: Error) {
    super(answer.message);
    this.name = 'PaneBusy';
  }
}

/**
 * The message WAS typed and nothing proved it landed (Ferrets' `HarnessUnconfirmed`). Neither a refusal nor a failure:
 * the record stays, settled as unaccounted, and the answer names the send so the person can act on exactly it.
 */
export class Unconfirmed extends Error {
  constructor(readonly stranded: boolean) {
    super(stranded ? STRANDED_SENTENCE : UNCONFIRMED_SENTENCE);
    this.name = 'Unconfirmed';
  }
}

/** Said when this daemon's Ferrets offers no harness seam (it is optional on the port). */
const SEAM_OFF =
  "Ferrets does not offer a way to reach this ferret's terminal, so Conversation cannot type into it yet.";

/** A harness refusal, in the words and status today's send routes give for that case. */
function refusalAnswer(refusal: HarnessRefusal, noPane: string): Error {
  switch (refusal.refused) {
    case 'no_pane':
      return new SessionSendError('refused', noPane);
    case 'plugin_unavailable':
      return new ApiError(503, "the runner that owns this ferret's terminal is off", 'plugin_unavailable');
    default:
      return new ApiError(409, REFUSAL_SENTENCES[refusal.refused], refusal.refused);
  }
}

/**
 * Every delivery failure Ferrets can answer, as the send routes answer it (today's `sendRefusal` over the classes these
 * replace): typed and not proven is {@link Unconfirmed} (409 `send_unconfirmed`, record kept); a pane that never came
 * to a prompt or a composer that could not be read is 409 `send_refused` (nothing typed); a composer that held the
 * person's own text is 409 `composer_occupied` with that draft, and the draft goes nowhere else; any other refusal is
 * {@link refusalAnswer}'s. Exhaustive: a new kind in Ferrets' taxonomy does not compile until it is answered here.
 */
function deliveryAnswer(ferret: string, failure: HarnessDeliveryFailure): Error {
  if ('unconfirmed' in failure) return new Unconfirmed(failure.stranded);
  switch (failure.refused) {
    case 'not_ready':
      return new SessionSendError('refused', NOT_READY_SENTENCES[failure.why]);
    case 'composer_occupied': {
      const refusal = composerOccupiedRefusal(failure.draft);
      return new SessionSendError('refused', refusal.message, refusal.draft);
    }
    case 'composer_unreadable':
      return new SessionSendError('refused', composerUnreadableRefusal().message);
    default:
      return refusalAnswer(failure, `session ${ferret} has no live agent to type into; revive it first`);
  }
}

/** A rejection is a failure nobody could classify: what reached the pane is uncertain, so the record stays. */
const uncertain = (error: unknown): never => {
  throw new MaybeTyped(
    error instanceof ApiError || error instanceof SessionSendError
      ? error
      : new SessionSendError('failed', error instanceof Error ? error.message : String(error)),
  );
};

export function terminalSeam(ferrets: Pick<FerretsApi, 'harness'>): TerminalSeam {
  /** The ferret's harness, or the answer for why there is none. */
  const open = async (ferret: string): Promise<FerretHarness> => {
    if (ferrets.harness === undefined) throw new ApiError(503, SEAM_OFF, 'plugin_unavailable');
    const id = tryParseSessionId(ferret);
    const harness = id === undefined ? undefined : await ferrets.harness(id);
    if (harness === undefined) throw new SessionSendError('not_found', `session not found: ${ferret}`);
    return harness;
  };
  return {
    bind: async ferret => {
      const harness = await open(ferret);
      return {
        deliver: async text => {
          const delivered = await harness.deliver({ text }).catch(uncertain);
          if (delivered.ok) return delivered.value;
          const answer = deliveryAnswer(ferret, delivered.error);
          const busy = 'refused' in delivered.error && delivered.error.refused === 'not_ready';
          throw busy && delivered.error.why === 'busy' ? new PaneBusy(answer) : answer;
        },
        queue: async (text, sendId) => {
          const queued = await harness.queue(text, { sendId }).catch(uncertain);
          if (queued.ok) return queued.value;
          if ('refused' in queued.error && queued.error.refused === 'plugin_unavailable') return undefined;
          throw deliveryAnswer(ferret, queued.error);
        },
        interrupt: async () => {
          const interrupted = await harness.interrupt();
          if (!interrupted.ok) throw refusalAnswer(interrupted.error, INTERRUPT_NO_PANE);
          return {
            pressed: interrupted.value.pressed,
            ...(interrupted.value.working === undefined ? {} : { working: interrupted.value.working }),
          };
        },
      };
    },
  };
}
