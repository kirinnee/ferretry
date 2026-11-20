/**
 * A recording `StepHost` for a step page's tests: the REAL contract type (`@ferretry/kernel/contract`), a few lines of
 * recorder. It stands where O1's `stepHarness` (`@ferretry/plugin-onboarding/contract/testing`) would, because using
 * that harness here needs a cross-plugin devDependency, which edits `bun.lock` and `nix/bun-deps.inputs` in every unit
 * that does it and collides across the parallel r10 units. Swap it for the harness when that dependency is shared.
 */
import type { StepHost, StepSegmentMemory } from '@ferretry/kernel/contract';

type StepCall =
  | { readonly kind: 'ready' | 'notNeeded' | 'done' | 'next' | 'back' }
  | { readonly kind: 'skip'; readonly why: 'not-needed' | 'already-set' }
  | { readonly kind: 'busy'; readonly label: string | null }
  | { readonly kind: 'remember'; readonly patch: StepSegmentMemory };

export interface StepHostRecorder {
  readonly host: StepHost;
  readonly calls: readonly StepCall[];
  count(kind: StepCall['kind']): number;
  readonly decision: 'shown' | 'skipped' | 'undecided';
  readonly skippedWhy: 'not-needed' | 'already-set' | undefined;
}

export function stepHostRecorder(phase: 'daemon' | 'client' = 'client'): StepHostRecorder {
  const calls: StepCall[] = [];
  let segment: StepSegmentMemory = {};
  const host: StepHost = {
    phase,
    appliesTo: [],
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
  const skipped = () => calls.find(call => call.kind === 'skip');
  return {
    host,
    calls,
    count: kind => calls.filter(call => call.kind === kind).length,
    get decision() {
      if (skipped() !== undefined) return 'skipped';
      return calls.some(call => call.kind === 'ready') ? 'shown' : 'undecided';
    },
    get skippedWhy() {
      const call = skipped();
      return call?.kind === 'skip' ? call.why : undefined;
    },
  };
}
