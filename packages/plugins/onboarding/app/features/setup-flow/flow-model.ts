/**
 * THE SETUP FLOW AS DATA (pure: no React, no storage, no clock): which pages the run walks, where it is, and what the
 * progress bar says. `flatten.ts` decides the order of every declared step; this file decides what a RUN does with it:
 *
 *   - a page already answered BEFORE the run (a daemon step the machine recorded, a client step left for later) is not
 *     asked again: the run resumes at the first unanswered page;
 *   - a page that skips itself while the run is going (`StepHost.skip`) is `gone` for the rest of the run: never counted,
 *     never landed on by Back;
 *   - Back goes to the page the person actually came from (the trail), not to the one before it in the list.
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
  /** Which way the last move went: the page slides in from that side. */
  readonly direction: 'forward' | 'back';
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
  direction: 'forward',
});

/** Moves on from the current page to the next one still to ask. At the end it stays at the end. */
export function advance(state: RunState, pages: readonly FlowStep[], answered: ReadonlySet<string>): RunState {
  if (state.at === END) return state;
  const index = pages.findIndex(page => page.key === state.at);
  const at = liveAfter(pages, answered, state.gone, index + 1);
  return { ...state, at, trail: [...state.trail, state.at], direction: 'forward' };
}

/** Goes back to the page the person came from, passing none that has gone since. At the first page it stays. */
export function retreat(state: RunState): RunState {
  const trail = [...state.trail];
  let back = trail.pop();
  while (back !== undefined && state.gone.has(back)) back = trail.pop();
  return back === undefined ? state : { ...state, at: back, trail, direction: 'back' };
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
  return { ...state, gone, at: liveAfter(pages, answered, gone, index + 1), direction: 'forward' };
}

/** The pages that still count: not answered before the run, not gone. */
const livePages = (
  pages: readonly FlowStep[],
  answered: ReadonlySet<string>,
  gone: ReadonlySet<string>,
): readonly FlowStep[] => pages.filter(page => !answered.has(page.key) && !gone.has(page.key));

/** The progress bar's one segment for the whole client phase (every plugin's client pages read as "This device"). */
const DEVICE_SEGMENT = { id: 'device', label: 'This device' } as const;

export interface ProgressRead {
  readonly segments: readonly { readonly id: string; readonly label: string }[];
  readonly current: string;
  readonly step: number;
  readonly of: number;
}

/**
 * The bar for the page on screen: one segment per plugin that still has a page to ask on the machine, then one for this
 * device; "n of m" counts the live pages of the current segment, so skipped pages never count and the total can shrink
 * but never grows backwards.
 */
export function progressOf(
  flow: Flow,
  pages: readonly FlowStep[],
  answered: ReadonlySet<string>,
  gone: ReadonlySet<string>,
  at: string,
): ProgressRead | undefined {
  const live = livePages(pages, answered, gone);
  const here = pages.find(page => page.key === at);
  if (here === undefined) return undefined;
  const segmentOf = (step: FlowStep): string => (step.phase === 'client' ? DEVICE_SEGMENT.id : step.plugin);
  const labels = new Map<string, string>();
  for (const segment of flow.daemon) labels.set(segment.plugin, segment.group);
  const segments: { id: string; label: string }[] = [];
  for (const page of live) {
    const id = segmentOf(page);
    if (!segments.some(segment => segment.id === id))
      segments.push({ id, label: id === DEVICE_SEGMENT.id ? DEVICE_SEGMENT.label : (labels.get(id) ?? id) });
  }
  const id = segmentOf(here);
  const inSegment = live.filter(page => segmentOf(page) === id);
  const place = inSegment.findIndex(page => page.key === at);
  // The page on screen is live while it is shown; a page that just answered itself keeps its place.
  return {
    segments,
    current: id,
    step: Math.max(1, place + 1),
    of: Math.max(1, inSegment.length),
  };
}
