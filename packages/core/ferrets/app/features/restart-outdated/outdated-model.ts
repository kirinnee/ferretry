/**
 * Which ferrets run on out-of-date instructions, and how the list says so (docs/launch-settings.md, "Restarting ferrets
 * whose instructions are out of date").
 *
 * The daemon decides: a summary carries `outdated` only while the instructions it would launch with today differ from the
 * ones it launched with and the daemon could not live-patch them. The page never recomputes that; it counts the marks
 * and words the sections.
 */
import type { FerretSummary, RestartRequest, RestartResult } from '../../../contract/index.ts';
import { isStopped } from '../list/list-model.ts';

/** The instruction sections a launch words (`FerretSummary.outdated.sections`). */
type LaunchInstructionSectionId = NonNullable<FerretSummary['outdated']>['sections'][number];

const SECTION_WORDS: Readonly<Record<LaunchInstructionSectionId, string>> = {
  tools: 'tools',
  settings: 'settings',
  notify: 'notifications',
  board: 'board rules',
  'sub-ferret': 'sub-ferret rules',
  hypermedia: 'hypermedia',
  pack: 'Pack mode',
  attention: 'attention',
  agenda: 'agenda',
  asks: 'asks',
  learning: 'learning',
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** A ferret that is still live and whose instructions are out of date: the ones a restart can fix. */
export const isOutdated = (ferret: FerretSummary): boolean => ferret.outdated !== undefined && !isStopped(ferret);

/** The sections that changed, as a phrase: "Pack mode and agenda". */
const outdatedSectionWords = (ferret: FerretSummary): string => {
  const words = (ferret.outdated?.sections ?? []).map(section => SECTION_WORDS[section]);
  return words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
};

/** The mark's tooltip and accessible name: what is stale and what fixes it. */
export const outdatedLabel = (ferret: FerretSummary): string => {
  const what = outdatedSectionWords(ferret);
  return `Outdated — restart to load new instructions${what === '' ? '' : ` (${what})`}`;
};

/** The ferrets "Restart outdated" would act on: outdated, and not already restarted or queued by the press the page remembers. */
export const outdatedFerrets = (
  ferrets: readonly FerretSummary[] | null,
  overlay?: { readonly restarted: ReadonlySet<string>; readonly queued: ReadonlySet<string> },
): readonly FerretSummary[] =>
  (ferrets ?? []).filter(
    ferret =>
      isOutdated(ferret) && !(overlay?.restarted.has(ferret.id) ?? false) && !(overlay?.queued.has(ferret.id) ?? false),
  );

/** The menu row's label: the count it will act on. */
export const restartButtonLabel = (count: number): string => `Restart outdated (${count})`;

/** The request the press sends: only what is outdated, never every ferret. */
export const OUTDATED_REQUEST: RestartRequest = { scope: 'outdated' };

/** What the restart did, as the halves a person cares about: restarted now, waiting for an idle moment, failed. */
export const restartSummary = (result: RestartResult): string => {
  const parts = [
    result.restarted.length === 0 ? '' : `${plural(result.restarted.length, 'ferret')} restarted now`,
    result.queued.length === 0 ? '' : `${plural(result.queued.length, 'ferret')} queued for their next idle moment`,
    result.failed.length === 0 ? '' : `${plural(result.failed.length, 'restart')} failed`,
  ].filter(part => part !== '');
  return parts.length === 0 ? 'Nothing needed restarting.' : `${parts.join(', ')}.`;
};
