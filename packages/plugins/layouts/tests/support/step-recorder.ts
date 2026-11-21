/**
 * A recording `StepHost` for a step page's tests: the kernel's contract, with every call kept in order. Onboarding's own
 * `stepHarness` does the same, but a plugin may not depend on another plugin, so this is the same ten lines locally.
 */
import type { StepHost, StepSegmentMemory } from '@ferretry/kernel/contract';

export interface StepRecorder {
  readonly host: StepHost;
  readonly calls: string[];
  count(kind: string): number;
  readonly decision: 'shown' | 'skipped' | 'undecided';
  readonly skippedWhy: string | undefined;
  readonly segment: StepSegmentMemory;
  /** The save the page last registered with `commit` (null when none or cleared). */
  readonly committed: (() => Promise<void>) | null;
}

export function stepRecorder(phase: StepHost['phase'] = 'client'): StepRecorder {
  const calls: string[] = [];
  let segment: StepSegmentMemory = {};
  let committed: (() => Promise<void>) | null = null;
  const host: StepHost = {
    phase,
    appliesTo: [],
    get segment() {
      return segment;
    },
    remember: patch => {
      segment = { ...segment, ...patch };
      calls.push('remember');
    },
    ready: () => void calls.push('ready'),
    skip: why => void calls.push(`skip:${why}`),
    notNeeded: () => void calls.push('notNeeded'),
    commit: save => {
      committed = save;
      calls.push(save === null ? 'commit:clear' : 'commit');
    },
    done: () => void calls.push('done'),
    busy: () => void calls.push('busy'),
    next: () => void calls.push('next'),
    back: () => void calls.push('back'),
  };
  const skip = () => calls.find(call => call.startsWith('skip:'));
  return {
    host,
    calls,
    count: kind => calls.filter(call => call === kind).length,
    get decision() {
      if (skip() !== undefined) return 'skipped';
      return calls.includes('ready') ? 'shown' : 'undecided';
    },
    get skippedWhy() {
      return skip()?.slice('skip:'.length);
    },
    get segment() {
      return segment;
    },
    get committed() {
      return committed;
    },
  };
}
