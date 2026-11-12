import {
  FORM_KEYS,
  type FormKey,
  type FerretHarness,
  type FerretsApi,
  type HarnessForm,
} from '@ferretry/core-ferrets/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { deliveryAnswer, refusalAnswer } from '../../harness-seam.ts';
import { tryParseSessionId } from '../../seams/ferret-id.ts';
import type { QuestionPaneState, StructuredQuestionPane } from './harness-question-driver.ts';

/** Said when this daemon's Ferrets offers no harness seam, or the harness offers no form acts (both are optional). */
export const FORM_OFF =
  "Ferrets does not offer a way to read or drive this ferret's question form, so it cannot be answered here. Answer it in the ferret's terminal.";

const NO_PANE = (ferret: string): string => `session ${ferret} has no live agent to answer for; revive it first`;

const isFormKey = (key: string): key is FormKey => (FORM_KEYS as readonly string[]).includes(key);

/**
 * THE FORM SEAM, as the structured-question driver reads it: the ferret's `FerretHarness.form` (capture, one closed key,
 * one paste), addressed by ferret id. Nothing here is a terminal act of its own: the runner behind the harness guards each
 * key and paste with `kernel.act(<pane>, 'keys')`, so a Vault hold types NOTHING, and masks each capture before it leaves.
 * This file turns the seam's answers into the errors the driver classifies (a refusal after a key has gone is ambiguous
 * there, one before it is not) and refuses any key outside {@link FORM_KEYS} before it is asked for.
 *
 * Access is not decided here: the answer path asks `ferrets.harness(id, caller)` first, which refuses (403) a ferret that
 * may not touch this one, and only then does the driver run.
 */
export function harnessFormPane(ferrets: Pick<FerretsApi, 'harness'>): StructuredQuestionPane {
  const seam = async (ferret: string): Promise<FerretHarness> => {
    if (ferrets.harness === undefined) throw new ApiError(503, FORM_OFF, 'plugin_unavailable');
    const id = tryParseSessionId(ferret);
    const harness: FerretHarness | undefined = id === undefined ? undefined : await ferrets.harness(id);
    if (harness === undefined) throw new ApiError(404, `no session ${ferret}`, 'not-found');
    return harness;
  };
  const open = async (ferret: string): Promise<HarnessForm> => {
    const form = (await seam(ferret)).form;
    if (form === undefined) throw new ApiError(503, FORM_OFF, 'plugin_unavailable');
    return form;
  };
  return {
    state: async (ferret): Promise<QuestionPaneState> => {
      const captured = await (await open(ferret)).capture();
      if (!captured.ok) throw refusalAnswer(captured.error, NO_PANE(ferret));
      return captured.value;
    },
    // The transcript names the call or its result by id: the one outside witness that the question is over. Unreadable
    // proves nothing.
    completed: async (ferret, toolUseId) => {
      const entries = await (await seam(ferret)).transcript.read().catch(() => undefined);
      return entries?.some(entry => entry.tools?.results?.includes(toolUseId) ?? false) ?? false;
    },
    sendKey: async (ferret, key) => {
      if (!isFormKey(key))
        throw new ApiError(409, `${JSON.stringify(key)} is not a key a question form is driven with`, 'answer_refused');
      const typed = await (await open(ferret)).key(key);
      if (!typed.ok) throw deliveryAnswer(ferret, typed.error);
    },
    paste: async (ferret, text) => {
      const typed = await (await open(ferret)).paste(text);
      if (!typed.ok) throw deliveryAnswer(ferret, typed.error);
    },
  };
}
