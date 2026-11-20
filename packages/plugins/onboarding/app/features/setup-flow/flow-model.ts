/**
 * THE SETUP FLOW AS DATA (pure: no React, no storage, no clock): which pages the run walks, where it is, and what the
 * progress bar says. `flatten.ts` decides the order of every declared step; this file decides what a RUN does with it:
 *
 *   - a page already answered BEFORE the run (a daemon step the machine recorded, a client step left for later) is not
 *     asked again: the run resumes at the first unanswered page;
 *   - a page that skips itself while the run is going (`StepHost.skip`) is `gone` for the rest of the run: never counted,
 *     never landed on by Back;
 *   - Back goes to the page the person actually came from (the trail), not to the one before it in the list;
 *   - a page that is NOT NEEDED for this run (`StepHost.notNeeded`, contract rule 7) is passed over in both directions, is
 *     never counted, and is never recorded: it is a mark of this run only, cleared whenever its plugin's segment memory
 *     changes so the page is asked again.
 *
 * The position is a step KEY (`<plugin>.<step>`), never an index, so a step list that changes under a run cannot move it.
 */
import { askableSteps, type Flow, type FlowStep } from '../../lib/index.ts';

/** The place after the last page. */
export const END = 'end' as const;
export type Place = string | typeof END;

export interface RunState {
  readonly at: Place;
  /** The pages the person came through, oldest first (what Back pops). */
  readonly trail: readonly string[];
  /** Pages that skipped themselves during this run. */
  readonly gone: ReadonlySet<string>;
  /** Pages that said they are not needed for this run, given the answers so far (cleared when their plugin's memory changes). */
  readonly notNeeded: ReadonlySet<string>;
  /** Which way the last move went: the page slides in from that side. */
  readonly direction: 'forward' | 'back';
  /** Counts the moves of this run: a callback a page handed out is good only for the visit it was made in (see use-setup-flow.ts). */
  readonly visit: number;
}

/** Every page the flow could mount, in flow order: the machine's, then this device's. */
export const pagesOf = (flow: Flow): readonly FlowStep[] => [
  ...askableSteps(flow.daemon),
  ...askableSteps(flow.client),
];

/** A daemon step the machine recorded an answer for, or a client step left for later, was answered before this run. */
const isAnsweredBefore = (step: FlowStep, later: ReadonlySet<string>): boolean =>
  step.phase === 'daemon' ? step.state !== undefined && step.state !== 'pending' : later.has(step.key);

/** The keys of the pages answered before the run starts. */
export const answeredBefore = (pages: readonly FlowStep[], later: ReadonlySet<string>): ReadonlySet<string> =>
  new Set(pages.filter(page => isAnsweredBefore(page, later)).map(page => page.key));

const NONE: ReadonlySet<string> = new Set();

/** Every page the run does not draw: the ones it gave up on and the ones marked not needed. */
export const passedOver = (state: Pick<RunState, 'gone' | 'notNeeded'>): ReadonlySet<string> =>
  state.notNeeded.size === 0 ? state.gone : new Set([...state.gone, ...state.notNeeded]);

const liveAfter = (
  pages: readonly FlowStep[],
  skipped: ReadonlySet<string>,
  gone: ReadonlySet<string>,
  from: number,
): Place => pages.slice(from).find(page => !skipped.has(page.key) && !gone.has(page.key))?.key ?? END;

/** The start of a run: the first page nobody answered yet, or the end when everything was. */
export const startRun = (pages: readonly FlowStep[], answered: ReadonlySet<string>): RunState => ({
  at: liveAfter(pages, answered, NONE, 0),
  trail: [],
  gone: NONE,
  notNeeded: NONE,
  direction: 'forward',
  visit: 0,
});

/** Moves on from the current page to the next one still to ask. At the end it stays at the end. */
export function advance(state: RunState, pages: readonly FlowStep[], answered: ReadonlySet<string>): RunState {
  if (state.at === END) return state;
  const index = pages.findIndex(page => page.key === state.at);
  const at = liveAfter(pages, answered, passedOver(state), index + 1);
  return { ...state, at, trail: [...state.trail, state.at], direction: 'forward', visit: state.visit + 1 };
}

/** Goes back to the page the person came from, passing none that has gone since. At the first page it stays. */
export function retreat(state: RunState): RunState {
  const trail = [...state.trail];
  const hidden = passedOver(state);
  let back = trail.pop();
  while (back !== undefined && hidden.has(back)) back = trail.pop();
  return back === undefined ? state : { ...state, at: back, trail, direction: 'back', visit: state.visit + 1 };
}

/**
 * A page that decided not to show: it is gone for the rest of the run, and if it is the one on screen the run moves on
 * WITHOUT putting it on the trail (Back must not land on a page that draws nothing).
 */
export function dropPage(
  state: RunState,
  pages: readonly FlowStep[],
  answered: ReadonlySet<string>,
  key: string,
): RunState {
  if (state.gone.has(key)) return state;
  const gone = new Set(state.gone).add(key);
  if (state.at !== key) return { ...state, gone };
  const index = pages.findIndex(page => page.key === key);
  return {
    ...state,
    gone,
    at: liveAfter(pages, answered, new Set([...gone, ...state.notNeeded]), index + 1),
    direction: 'forward',
    visit: state.visit + 1,
  };
}

/**
 * A page that is not needed for THIS run: marked, and if it is the one on screen the run passes over it WITHOUT putting
 * it on the trail, in the direction it was travelling (a page reached by Back that is no longer needed sends the person
 * on back to the page before it, or forward when there is none). Nothing is recorded: the mark lives in the run only.
 */
export function markNotNeeded(
  state: RunState,
  pages: readonly FlowStep[],
  answered: ReadonlySet<string>,
  key: string,
): RunState {
  if (state.notNeeded.has(key)) return state;
  const marked = { ...state, notNeeded: new Set(state.notNeeded).add(key) };
  if (state.at !== key) return marked;
  if (state.direction === 'back') {
    const earlier = retreat(marked);
    if (earlier !== marked) return earlier;
  }
  const index = pages.findIndex(page => page.key === key);
  return {
    ...marked,
    at: liveAfter(pages, answered, passedOver(marked), index + 1),
    direction: 'forward',
    visit: state.visit + 1,
  };
}

/**
 * The plugin's segment memory changed: the pages of that plugin the run has not passed yet (the page on screen and the
 * ones after it) are asked again, so none of THEIR marks stands. A mark BEHIND the page on screen stays: nothing the run
 * can do from here goes back to that page (Back lands on shown pages, and a change made on an earlier page clears it then),
 * so a later page leaving its own memory (a scan key) must not bring a passed-over page back into the count.
 */
export function clearNotNeeded(state: RunState, pages: readonly FlowStep[], plugin: string): RunState {
  if (state.notNeeded.size === 0) return state;
  const here = state.at === END ? pages.length : pages.findIndex(page => page.key === state.at);
  const stays = new Set(
    [...state.notNeeded].filter(key => {
      const index = pages.findIndex(page => page.key === key);
      return pages[index]?.plugin !== plugin || index < here;
    }),
  );
  return stays.size === state.notNeeded.size ? state : { ...state, notNeeded: stays };
}

/** The progress bar's one segment for the whole client phase (every plugin's client pages read as "This device"). */
const DEVICE_SEGMENT = { id: 'device', label: 'This device' } as const;

export interface ProgressRead {
  readonly segments: readonly { readonly id: string; readonly label: string }[];
  readonly current: string;
  /** The place of the page on screen among the segment's pages that will be SHOWN. */
  readonly step: number;
  /** The segment's pages that will be shown (see `progressOf`). */
  readonly of: number;
  /** The counter is the current segment's own pages, so the bar fills that segment `step` of `of` (see `StepProgress`). */
  readonly fills: true;
}

/**
 * The bar for the page on screen, in ONE model for the whole run:
 *   - THE BAR is the run's segments: one per plugin that has a page this run does not already hold an answer for, then one
 *     for this device. Its count never changes while the run goes (a segment whose pages all pass over stays in it).
 *   - THE WORDS are "<segment> · page i of n": n counts the segment's pages that WILL BE SHOWN, i is the page on screen's place
 *     among them. A page passed over (it said so, or gave up), a page answered before the run, and a page the answers already
 *     given foresee passing over (`foreseen`, see foresight.ts) are never counted, so n shrinks only when a page learns it is
 *     not needed and grows back only when an answer changes. The page on screen always counts.
 */
export function progressOf(
  flow: Flow,
  pages: readonly FlowStep[],
  answered: ReadonlySet<string>,
  passed: ReadonlySet<string>,
  foreseen: ReadonlySet<string>,
  at: string,
): ProgressRead | undefined {
  const here = pages.find(page => page.key === at);
  if (here === undefined) return undefined;
  const asked = pages.filter(page => !answered.has(page.key));
  const segmentOf = (step: FlowStep): string => (step.phase === 'client' ? DEVICE_SEGMENT.id : step.plugin);
  const labels = new Map<string, string>();
  for (const segment of flow.daemon) labels.set(segment.plugin, segment.group);
  const segments: { id: string; label: string }[] = [];
  for (const page of asked) {
    const id = segmentOf(page);
    if (!segments.some(segment => segment.id === id))
      segments.push({ id, label: id === DEVICE_SEGMENT.id ? DEVICE_SEGMENT.label : (labels.get(id) ?? id) });
  }
  const id = segmentOf(here);
  const shown = asked.filter(
    page => segmentOf(page) === id && (page.key === at || !(passed.has(page.key) || foreseen.has(page.key))),
  );
  const place = shown.findIndex(page => page.key === at);
  return {
    segments,
    current: id,
    step: Math.max(1, place + 1),
    of: Math.max(1, shown.length),
    fills: true,
  };
}
