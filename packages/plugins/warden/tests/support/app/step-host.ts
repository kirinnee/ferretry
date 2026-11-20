/**
 * A recording `StepHost` for the Warden's first-run page. A small copy of Onboarding's `stepHarness`
 * (`@ferretry/plugin-onboarding/contract/testing`, which this plugin does not declare as a dependency): it records every
 * call in order and keeps the segment memory the page wrote.
 */
import type { StepHost } from '@ferretry/kernel/contract';

export interface RecordedStep {
  readonly host: StepHost;
  /** `ready`, `skip:<why>`, `done`, `busy:<label>`, `busy:null`, `next`, `back`, in order. */
  readonly events: readonly string[];
  /** What Next would save (`commit`), or null when the page registered none; the last registration wins. */
  readonly runCommit: () => Promise<void>;
}

export function recordedStep(): RecordedStep {
  const events: string[] = [];
  let save: (() => Promise<void>) | null = null;
  const host: StepHost = {
    phase: 'daemon',
    appliesTo: [],
    segment: {},
    remember: patch => void events.push(`remember:${JSON.stringify(patch)}`),
    ready: () => void events.push('ready'),
    skip: why => void events.push(`skip:${why}`),
    notNeeded: () => void events.push('notNeeded'),
    commit: next => {
      save = next;
      events.push(next === null ? 'commit:null' : 'commit');
    },
    done: () => void events.push('done'),
    busy: label => void events.push(`busy:${label}`),
    next: () => void events.push('next'),
    back: () => void events.push('back'),
  };
  return { host, events, runCommit: async () => await (save?.() ?? Promise.resolve()) };
}
