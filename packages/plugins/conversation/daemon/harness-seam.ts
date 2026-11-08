import type {
  DeliveryOutcome,
  FerretHarness,
  FerretId,
  FerretsApi,
  HarnessRefusal,
} from '@ferretry/core-ferrets/contract';
import { ApiError, REFUSAL_SENTENCES } from '@ferretry/kernel/contract';
import { SessionSendError } from './delivery/lib/mounts/session-send.ts';
import { tryParseSessionId } from './seams/ferret-id.ts';

/**
 * THE TERMINAL SEAM: what Conversation types into a ferret, and the stop it presses, go through Ferrets' harness seam
 * (`FerretsApi.harness`). Ferrets' runner already acts on the ferret's terminal for every write it makes (Vault's holds
 * apply there), so this file wraps NOTHING in an act of its own: an outer act on that terminal would wait on the inner
 * one and neither would settle.
 *
 * The seam is the one place a refusal of the harness becomes Conversation's words, so every route and the port answer a
 * pane that is gone, a hold or a plugin that is off the same way.
 */
export interface TerminalSeam {
  /**
   * Opens the ferret's terminal. Throws before anything can be typed when the ferret is unknown (404), Ferrets refuses
   * the caller (403 `forbidden`, its mayTouch rule) or Ferrets offers no seam (503), so a send records nothing then.
   */
  bind(ferret: string, caller?: FerretId): Promise<BoundTerminal>;
}

/** One ferret's terminal, as Ferrets opened it. */
interface BoundTerminal {
  /**
   * Types one message. Throws the answer the send routes give for a refusal (nothing was typed), or {@link MaybeTyped}
   * when the runner threw while it wrote.
   */
  deliver(text: string): Promise<DeliveryOutcome>;
  /** Presses the harness's interrupt. Throws as {@link BoundTerminal.deliver} does for a refusal. */
  interrupt(): Promise<void>;
}

/**
 * The runner threw while it wrote: keys may already have gone to the pane, so the send's fate is UNCERTAIN rather than
 * absent, and its record must stay (a withdrawal would invite a duplicate retry). `answer` is what the caller is told.
 */
export class MaybeTyped extends Error {
  constructor(readonly answer: Error) {
    super(answer.message);
    this.name = 'MaybeTyped';
  }
}

/** Said when this daemon's Ferrets offers no harness seam (it is optional on the port). */
const SEAM_OFF =
  "Ferrets does not offer a way to reach this ferret's terminal, so Conversation cannot type into it yet.";

/** A harness refusal, in the words and status today's send routes give for that case. */
function refusalAnswer(ferret: string, refusal: HarnessRefusal): Error {
  switch (refusal.refused) {
    case 'no_pane':
      return new SessionSendError('refused', `session ${ferret} has no live agent to type into; revive it first`);
    case 'plugin_unavailable':
      return new ApiError(503, "the runner that owns this ferret's terminal is off", 'plugin_unavailable');
    default:
      return new ApiError(409, REFUSAL_SENTENCES[refusal.refused], refusal.refused);
  }
}

export function terminalSeam(ferrets: Pick<FerretsApi, 'harness'>): TerminalSeam {
  /** The ferret's harness, or the answer for why there is none. `forbidden` (403) is Ferrets' and passes through. */
  const open = async (ferret: string, caller: FerretId | undefined): Promise<FerretHarness> => {
    if (ferrets.harness === undefined) throw new ApiError(503, SEAM_OFF, 'plugin_unavailable');
    const id = tryParseSessionId(ferret);
    const harness = id === undefined ? undefined : await ferrets.harness(id, caller);
    if (harness === undefined) throw new SessionSendError('not_found', `session not found: ${ferret}`);
    return harness;
  };
  return {
    bind: async (ferret, caller) => {
      const harness = await open(ferret, caller);
      return {
        deliver: async text => {
          const delivered = await harness.deliver({ text }).catch((error: unknown) => {
            // A refusal Ferrets already worded passes as it is; any other failure of the write is a send that failed.
            throw new MaybeTyped(
              error instanceof ApiError || error instanceof SessionSendError
                ? error
                : new SessionSendError('failed', error instanceof Error ? error.message : String(error)),
            );
          });
          if (!delivered.ok) throw refusalAnswer(ferret, delivered.error);
          return delivered.value;
        },
        interrupt: async () => {
          const interrupted = await harness.interrupt();
          if (!interrupted.ok) throw refusalAnswer(ferret, interrupted.error);
        },
      };
    },
  };
}
