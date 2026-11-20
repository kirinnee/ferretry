/**
 * THE TEST HOST FOR A STEP PAGE. A plugin unit mounts its page with `harness.host` as `PanelProps.step` and asserts on what
 * the page told it, without the setup flow (O4) being there. It is a real `StepHost` that records every call in order and
 * keeps the segment memory the page wrote, so "skips when importMode is everything" is one line of test.
 */
import type { StepHost, StepSegmentMemory } from '@ferretry/kernel/contract';
import type { StepCall, StepSkipWhy } from '../step-host.ts';

export interface StepHarnessOptions {
  readonly phase?: 'daemon' | 'client';
  readonly appliesTo?: StepHost['appliesTo'];
  /** Earlier answers of the same plugin (`{ importMode: 'everything' }`). */
  readonly segment?: StepSegmentMemory;
}

export interface StepHarness {
  readonly host: StepHost;
  readonly calls: readonly StepCall[];
  /** How many times the page made this call. */
  count(kind: StepCall['kind']): number;
  /**
   * What the page decided: shown (`ready`), not shown for good (`skip`), not shown this run (`notNeeded`), or nothing yet
   * (still under the loading cover).
   */
  readonly decision: 'shown' | 'skipped' | 'passed-over' | 'undecided';
  readonly skippedWhy: StepSkipWhy | undefined;
  /** The segment memory as the page left it. */
  readonly segment: StepSegmentMemory;
}

export function stepHarness(options: StepHarnessOptions = {}): StepHarness {
  const calls: StepCall[] = [];
  let segment: StepSegmentMemory = { ...options.segment };
  const host: StepHost = {
    phase: options.phase ?? 'daemon',
    appliesTo: options.appliesTo ?? [],
    get segment() {
      return segment;
    },
    remember: patch => {
      segment = { ...segment, ...patch };
      calls.push({ kind: 'remember', patch });
    },
    ready: () => void calls.push({ kind: 'ready' }),
    skip: why => void calls.push({ kind: 'skip', why }),
    notNeeded: () => void calls.push({ kind: 'notNeeded' }),
    done: () => void calls.push({ kind: 'done' }),
    busy: label => void calls.push({ kind: 'busy', label }),
    next: () => void calls.push({ kind: 'next' }),
    back: () => void calls.push({ kind: 'back' }),
  };
  const skipped = (): StepCall | undefined => calls.find(call => call.kind === 'skip');
  return {
    host,
    calls,
    count: kind => calls.filter(call => call.kind === kind).length,
    get decision() {
      if (skipped() !== undefined) return 'skipped';
      // Rule 7: `notNeeded()` counts only from a page still passing over; after `ready()` or a `busy(label)` the shell ignores it.
      const shownAt = calls.findIndex(call => call.kind === 'ready' || (call.kind === 'busy' && call.label !== null));
      const passedAt = calls.findIndex(call => call.kind === 'notNeeded');
      if (passedAt !== -1 && (shownAt === -1 || passedAt < shownAt)) return 'passed-over';
      return calls.some(call => call.kind === 'ready') ? 'shown' : 'undecided';
    },
    get skippedWhy() {
      const call = skipped();
      return call?.kind === 'skip' ? call.why : undefined;
    },
    get segment() {
      return segment;
    },
  };
}
