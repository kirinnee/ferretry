/**
 * A recording `StepHost` for a first-run page: the real kernel interface (`@ferretry/kernel/contract`), with each call
 * kept in order and the segment memory the page wrote. It mirrors Onboarding's `stepHarness()` (contract/testing); this
 * plugin does not take a dependency on another plugin just for its tests, which would also change the install digest.
 */
import type { StepHost, StepSegmentMemory } from '@ferretry/kernel/contract';

type HostCall =
  | { readonly kind: 'ready' }
  | { readonly kind: 'skip'; readonly why: 'not-needed' | 'already-set' }
  | { readonly kind: 'notNeeded' }
  | { readonly kind: 'done' }
  | { readonly kind: 'busy'; readonly label: string | null }
  | { readonly kind: 'commit'; readonly registered: boolean }
  | { readonly kind: 'remember'; readonly patch: StepSegmentMemory }
  | { readonly kind: 'next' }
  | { readonly kind: 'back' };

export interface RecordingHost {
  readonly host: StepHost;
  readonly calls: readonly HostCall[];
  count(kind: HostCall['kind']): number;
  /** Shown (`ready`), not shown (`skip`), or nothing yet (still under the loading cover). */
  readonly decision: 'shown' | 'skipped' | 'undecided';
  /** Whether a save is registered for Next (contract rule 8). */
  readonly hasCommit: boolean;
  /** What the shell's Next does: runs the registered save (resolves at once when none is registered). */
  runCommit(): Promise<void>;
}

export function recordingHost(phase: StepHost['phase'] = 'daemon'): RecordingHost {
  const calls: HostCall[] = [];
  let segment: StepSegmentMemory = {};
  let commit: (() => Promise<void>) | null = null;
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
    commit: save => {
      commit = save;
      calls.push({ kind: 'commit', registered: save !== null });
    },
    done: () => void calls.push({ kind: 'done' }),
    busy: label => void calls.push({ kind: 'busy', label }),
    next: () => void calls.push({ kind: 'next' }),
    back: () => void calls.push({ kind: 'back' }),
  };
  return {
    host,
    calls,
    count: kind => calls.filter(call => call.kind === kind).length,
    get hasCommit() {
      return commit !== null;
    },
    runCommit: async () => {
      await commit?.();
    },
    get decision() {
      if (calls.some(call => call.kind === 'skip')) return 'skipped';
      return calls.some(call => call.kind === 'ready') ? 'shown' : 'undecided';
    },
  };
}
