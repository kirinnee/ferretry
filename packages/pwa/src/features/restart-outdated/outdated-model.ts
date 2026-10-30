/**
 * Which ferrets run on out-of-date instructions, and how the page says so (docs/launch-settings.md,
 * "Restarting ferrets whose instructions are out of date").
 *
 * The daemon decides: a view carries `outdated` only while the instructions it would launch with today differ
 * from the ones it launched with and the daemon could not live-patch them. The page never recomputes that; it
 * counts the marks and words the sections.
 */
import {
  DORMANT_AGENT_STATUSES,
  type LaunchInstructionSectionId,
  type RestartRequest,
  type RestartResult,
  type SessionView,
} from '@ferretry/protocol';

const SECTION_WORDS: Readonly<Record<LaunchInstructionSectionId, string>> = {
  tools: 'tools',
  settings: 'settings',
  notify: 'notifications',
  hypermedia: 'hypermedia',
  pack: 'Pack mode',
  attention: 'attention',
  agenda: 'agenda',
  learning: 'learning',
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** A ferret that is still live and whose instructions are out of date: the ones a restart can fix. */
export const isOutdated = (view: SessionView): boolean =>
  view.outdated !== undefined && !DORMANT_AGENT_STATUSES.has(view.state.status);

/** The sections that changed, as a phrase: "Pack mode and agenda". */
export const outdatedSectionWords = (view: SessionView): string => {
  const words = (view.outdated?.sections ?? []).map(section => SECTION_WORDS[section]);
  return words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
};

/** The mark's tooltip and accessible name: what is stale and what fixes it. */
export const outdatedLabel = (view: SessionView): string => {
  const what = outdatedSectionWords(view);
  return `Outdated: running on older instructions${what === '' ? '' : ` (${what})`}. Restart to apply the new ones.`;
};

/**
 * The ferrets "Restart outdated" would act on: outdated, and not already restarted or queued by the press
 * the page still remembers (`restart-overlay.tsx`).
 */
export const outdatedViews = (
  sessions: readonly SessionView[] | null,
  overlay?: { readonly restarted: ReadonlySet<string>; readonly queued: ReadonlySet<string> },
): readonly SessionView[] =>
  (sessions ?? []).filter(
    view =>
      isOutdated(view) &&
      !(overlay?.restarted.has(view.config.id) ?? false) &&
      !(overlay?.queued.has(view.config.id) ?? false),
  );

/** The button's label: the count it will act on. */
export const restartButtonLabel = (count: number): string => `Restart outdated (${count})`;

/** The request the button sends: only what is outdated, never every ferret. */
export const OUTDATED_REQUEST: RestartRequest = { scope: 'outdated' };

/** What the restart did, as the two halves a person cares about: restarted now, waiting for an idle moment. */
export const restartSummary = (result: RestartResult): string => {
  const parts = [
    result.restarted.length === 0 ? '' : `${plural(result.restarted.length, 'ferret')} restarted now`,
    result.queued.length === 0 ? '' : `${plural(result.queued.length, 'ferret')} queued for their next idle moment`,
    result.failed.length === 0 ? '' : `${plural(result.failed.length, 'restart')} failed`,
  ].filter(part => part !== '');
  return parts.length === 0 ? 'Nothing needed restarting.' : `${parts.join(', ')}.`;
};
