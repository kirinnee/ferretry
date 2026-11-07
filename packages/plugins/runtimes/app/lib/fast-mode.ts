/**
 * What the PWA says about FAST MODE, decided from the session document alone.
 *
 * Fast mode is one boolean with three records behind it, in order of trust: what the harness last
 * REPORTED (`state.observedFast`), what the session was LAUNCHED with (`config.launchFast`), and the
 * harness's own default, which is off. A configured value is never presented as observed truth, so
 * the "unconfirmed" mark keeps naming the last reported value.
 *
 * SOLE OWNER of the `fy-fast-cost-note-v1` browser-storage key: the cost note is shown the first time
 * fast mode is turned on from this browser and never again. Storage is a per-viewer convenience that
 * may be absent or throw, so a denied store means the note simply shows again — never an error.
 */

import type { SessionView } from '@ferretry/protocol';
import type { RuntimeModelCatalog } from './runtime-models.ts';

/** The sole browser-storage key for the "fast mode can cost more" note. */
export const FAST_COST_NOTE_KEY = 'fy-fast-cost-note-v1';

/** The one sentence about what fast mode costs, said once and in the form's hint. */
export const FAST_COST_NOTE = 'Fast mode can cost more.';

export interface FastNoteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserStorage = (): FastNoteStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: FastNoteStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

/** Whether this browser has already been told fast mode can cost more. */
export const fastCostNoteSeen = (storage: FastNoteStorage | undefined = browserStorage()): boolean => {
  try {
    return storage?.getItem(FAST_COST_NOTE_KEY) === '1';
  } catch {
    return false;
  }
};

/** Remember the note was shown. A store that refuses just means it can show again. */
export const markFastCostNoteSeen = (storage: FastNoteStorage | undefined = browserStorage()): void => {
  try {
    storage?.setItem(FAST_COST_NOTE_KEY, '1');
  } catch {
    // Storage is a convenience; a refusal costs a repeated note, nothing else.
  }
};

/** A harness reports a model without the `[1m]` context-window selector the catalog id keeps. */
const withoutSelector = (model: string): string => model.replace(/\[[^\]]*\]$/u, '');

/** The model a session is running: what the harness reported, else what it was launched on. */
const modelOf = (view: SessionView): string | undefined => view.state.observedModel?.trim() || view.config.model;

const choiceFor = (catalog: RuntimeModelCatalog | null, model: string | undefined) =>
  catalog === null || model === undefined
    ? undefined
    : catalog.choices.find(entry => withoutSelector(entry.value) === withoutSelector(model));

/**
 * Whether fast mode is on for a session, as far as its document and the model's catalog entry say: the
 * harness's report, else the launch, else whether the model runs fast by default — and never on for a
 * model the catalog says has no fast mode (a login that saved it still runs such a model at standard speed).
 */
export const fastModeInForce = (view: SessionView, catalog: RuntimeModelCatalog | null = null): boolean => {
  const choice = choiceFor(catalog, modelOf(view));
  if (choice?.fast === false) return false;
  return view.state.observedFast ?? view.config.launchFast ?? choice?.fastDefault === true;
};

/**
 * Why fast mode cannot be offered for the model in force, or undefined when it can — or when the
 * daemon did not say, because only an explicit `false` is evidence.
 */
export const fastModeUnsupportedReason = (
  catalog: RuntimeModelCatalog | null,
  model: string | undefined,
): string | undefined => {
  const choice = choiceFor(catalog, model);
  return choice?.fast === false ? `${choice.label} has no fast mode.` : undefined;
};
