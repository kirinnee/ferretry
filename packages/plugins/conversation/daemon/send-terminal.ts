import type { FerretHarness, FerretsApi, RunnerPaneObservation } from '@ferretry/core-ferrets/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { SessionSendError } from './delivery/lib/mounts/session-send.ts';
import type {
  ComposerClearOutcome,
  ComposerSubmitOutcome,
  SendHeldAt,
  SendPaneObservation,
  SendQueueOutcome,
  SendTerminal,
} from './delivery/lib/types.ts';
import { deliveryAnswer, refusalAnswer } from './harness-seam.ts';
import { tryParseSessionId } from './seams/ferret-id.ts';

/** Said by the send path's typing members, which the host's own typing still carries. */
const TYPING_NOT_HERE =
  "Typing a message is carried by Conversation's send, not by this look at the ferret's terminal, so it was not typed here.";

/** Said when the ferret's terminal cannot be read at all. */
const NO_PANE_TO_READ = (ferret: string): string =>
  `session ${ferret} has no live agent whose terminal can be read; revive it first`;

/** A pane that is simply not there, as today's observation says one: nothing alive, nothing to act on. */
const ABSENT: SendPaneObservation = { alive: false, dead: false, promptReady: false, activeWork: false };

/** What the runner read, as the send path reads it: optional words only when there are some. */
const observed = (seen: RunnerPaneObservation): SendPaneObservation => ({
  alive: seen.alive,
  dead: seen.dead,
  promptReady: seen.promptReady,
  activeWork: seen.activeWork,
  ...(seen.startupParked === undefined ? {} : { startupParked: seen.startupParked }),
  ...(seen.blockingPrompt === undefined ? {} : { blockingPrompt: seen.blockingPrompt }),
  ...(seen.draft === undefined ? {} : { draft: seen.draft }),
});

/**
 * Today's `TmuxSendTerminal` over Ferrets' harness seam: the send path's pane look and composer acts, reached through
 * the ferret's runner, so every key is the runner's own act on the exact pane (Vault's holds apply) and nothing here
 * wraps one in a second act. A seam the runner does not offer (a member absent) is `plugin_unavailable`, never a guess:
 * the send path cannot prove a pane safe without reading it.
 */
export function harnessSendTerminal(ferrets: Pick<FerretsApi, 'harness'>): SendTerminal {
  const open = async (ferret: string): Promise<FerretHarness> => {
    if (ferrets.harness === undefined)
      throw new ApiError(503, "Ferrets does not offer a way to reach this ferret's terminal", 'plugin_unavailable');
    const id = tryParseSessionId(ferret);
    const harness = id === undefined ? undefined : await ferrets.harness(id);
    if (harness === undefined) throw new SessionSendError('not_found', `session not found: ${ferret}`);
    return harness;
  };
  const off = (): never => {
    throw new ApiError(503, "the runner that owns this ferret's terminal cannot do that", 'plugin_unavailable');
  };
  const unwired = (): never => {
    throw new ApiError(503, TYPING_NOT_HERE, 'conversation_terminal_unavailable');
  };
  return {
    observe: async ferret => {
      const seen = await (await open(ferret)).observe?.();
      if (seen === undefined) return off();
      if (seen.ok) return observed(seen.value);
      // A pane that is not there is a pane that is not alive (a send to it becomes a revive); any other refusal is the
      // seam's own answer (a hold, a runner that is off), never read as "nothing is wrong".
      if (seen.error.refused === 'no_pane') return ABSENT;
      throw refusalAnswer(seen.error, NO_PANE_TO_READ(ferret));
    },
    deliver: async () => unwired(),
    queue: async (): Promise<SendQueueOutcome> => unwired(),
    stopActiveTurn: async ferret => {
      const stopped = await (await open(ferret)).stopActive?.();
      if (stopped === undefined) return off();
      if (!stopped.ok) throw refusalAnswer(stopped.error, NO_PANE_TO_READ(ferret));
      return stopped.value === undefined ? ABSENT : observed(stopped.value);
    },
    heldAt: async (ferret, text): Promise<SendHeldAt | undefined> => {
      const held = await (await open(ferret)).heldAt?.(text);
      if (held === undefined) return off();
      if (!held.ok) throw refusalAnswer(held.error, NO_PANE_TO_READ(ferret));
      return held.value;
    },
    clearComposer: async (ferret, text): Promise<ComposerClearOutcome> => {
      const cleared = await (await open(ferret)).clearComposer?.(text);
      if (cleared === undefined) return off();
      if (!cleared.ok) throw deliveryAnswer(ferret, cleared.error);
      return cleared.value;
    },
    submitComposer: async (ferret, text, strict): Promise<ComposerSubmitOutcome> => {
      const submitted = await (await open(ferret)).submitComposer?.(text, strict);
      if (submitted === undefined) return off();
      if (!submitted.ok) throw deliveryAnswer(ferret, submitted.error);
      return submitted.value;
    },
  };
}
