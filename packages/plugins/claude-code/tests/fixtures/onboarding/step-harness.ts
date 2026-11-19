/**
 * TEMPORARY STAND-IN for O1's `stepHarness()` (PR #2119, `@ferretry/plugin-onboarding/contract/testing`; deleted when O1
 * merges, then the tests use the real one). It records what a page tells the shell, in order, and keeps the segment
 * memory the page wrote, with O1's `StepHost` shape (`remember`).
 */
import type { StepHost, StepSegmentMemory } from '../../../app/features/onboarding/kit.tsx';

export interface Harness {
  readonly step: StepHost;
  /** `ready`, `skip:not-needed`, `done`, `busy:<label>`, `busy:null`, … in the order the page called them. */
  readonly events: string[];
}

export const stepHarness = (segment: StepSegmentMemory = {}): Harness => {
  const events: string[] = [];
  let memory: StepSegmentMemory = { ...segment };
  const step: StepHost = {
    phase: 'daemon',
    appliesTo: [],
    get segment() {
      return memory;
    },
    remember: patch => {
      memory = { ...memory, ...patch };
      events.push('remember');
    },
    ready: () => void events.push('ready'),
    skip: why => void events.push(`skip:${why}`),
    done: () => void events.push('done'),
    busy: label => void events.push(`busy:${String(label)}`),
    next: () => void events.push('next'),
    back: () => void events.push('back'),
  };
  return { step, events };
};

export interface Call {
  readonly route: string;
  readonly init?: { readonly body?: unknown; readonly query?: unknown; readonly quiet?: boolean };
}

/** A scripted client: an answer per route key (a function, an Error to throw, or a value); every call is recorded. */
export const scripted = (table: Record<string, unknown>, calls: Call[] = []) => ({
  calls,
  call: async <Answer = unknown>(route: string, init?: Call['init']): Promise<Answer> => {
    calls.push({ route, ...(init === undefined ? {} : { init }) });
    if (!(route in table)) throw new Error(`no route ${route}`);
    const answer = table[route];
    const value = typeof answer === 'function' ? (answer as (init?: Call['init']) => unknown)(init) : answer;
    if (value instanceof Error) throw value;
    return value as Answer;
  },
  subscribe: () => () => undefined,
});
