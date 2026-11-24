/**
 * WHICH PAGES THE ANSWERS GIVEN SO FAR ALREADY PASS OVER (pure: no React, no storage, no clock).
 *
 * A page passes itself over (`StepHost.notNeeded`, contract rule 7) only when it MOUNTS, so the page counter would learn that
 * five import pages are not needed one visit at a time and "1 of 9" would become "2 of 4" a click later. The counter reads
 * this instead: from the plugin's segment memory (the answers already given in this run) it names the pages that WILL pass
 * themselves over, so the page count is right from the page where the answer is given, and moves only when an answer changes.
 * A page that passes itself over for a reason only the page can know (no shells, no MCP servers) is NOT forecast here: it stays
 * in the count as a passed page, which keeps the total from moving while the person walks forward.
 *
 * It is a counter's forecast, never a decision: a page still decides for itself when it mounts, and a page that is foreseen
 * but then shown is simply counted again (`progressOf` always counts the page on screen).
 *
 * The one rule is the import mode every import flow shares (`importMode`, remembered by the "what to bring over" page):
 * Import everything and Start fresh draw no checklist pages, and Start fresh draws no run page either.
 * GAP: a plugin whose pages pass over for another reason adds a row here; a manifest-declared rule would replace the table.
 */
import type { StepSegmentMemory } from '@ferretry/kernel/contract';
import type { FlowStep } from '../../lib/index.ts';

interface Forecast {
  /** The memory key the rule reads. */
  readonly key: string;
  /** The values of that key under which the pages are passed over. */
  readonly values: readonly string[];
  /** The step ids (inside the plugin that holds the memory) that pass over. */
  readonly steps: readonly string[];
}

/** What the "what to bring over" page has ticked when nothing was chosen yet (`importModeOf`'s caller defaults to it). */
const DEFAULT_IMPORT_MODE = 'everything';

const CHECKLIST_PAGES = ['import-settings', 'import-model-set', 'import-instructions', 'import-skills', 'import-mcp'];

const FORECASTS: readonly Forecast[] = [
  { key: 'importMode', values: ['everything', 'fresh'], steps: CHECKLIST_PAGES },
  { key: 'importMode', values: ['fresh'], steps: ['import-run'] },
];

/**
 * The keys of the pages the answers given so far will pass over. An import mode not chosen yet counts as the page's own default
 * ("Import everything"), so choosing it moves nothing and the total changes only when the person picks another mode.
 */
export function foreseenPassedOver(
  pages: readonly FlowStep[],
  memoryOf: (plugin: string) => StepSegmentMemory,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const page of pages) {
    if (page.phase !== 'daemon') continue;
    const memory = memoryOf(page.plugin);
    const passes = FORECASTS.some(rule => {
      const said = memory[rule.key];
      const mode = typeof said === 'string' ? said : DEFAULT_IMPORT_MODE;
      return rule.values.includes(mode) && rule.steps.includes(page.id);
    });
    if (passes) keys.add(page.key);
  }
  return keys;
}

/**
 * The pages of a harness the picker would leave out, until "Which AI" is answered: the pick ticked by default (`defaultOn`) is
 * counted, so the total changes when the person ticks another harness, never when they just press Next. A page on screen
 * always counts (`progressOf`).
 */
export function undecidedPages(
  pages: readonly FlowStep[],
  harnesses: ReadonlySet<string>,
  defaultOn: ReadonlySet<string>,
  pickPending: boolean,
): ReadonlySet<string> {
  const keys = new Set<string>();
  if (!pickPending) return keys;
  for (const page of pages)
    if (page.phase === 'daemon' && harnesses.has(page.plugin) && !defaultOn.has(page.plugin)) keys.add(page.key);
  return keys;
}
