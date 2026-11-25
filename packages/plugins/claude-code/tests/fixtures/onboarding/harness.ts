/**
 * O1's real `stepHarness` (`@ferretry/plugin-onboarding/contract/testing`), seen as a flat list of what the page told
 * the shell, in order: `ready`, `skip:not-needed`, `done`, `busy:<label>`, `busy:null`, `remember`, …
 */
import type { StepHost, StepSegmentMemory } from '@ferretry/kernel/contract';
import { stepHarness as realHarness } from '@ferretry/plugin-onboarding/contract/testing';

export interface Harness {
  readonly step: StepHost;
  readonly events: string[];
  /** Whether the page has a save registered for Next (rule 8). */
  readonly hasCommit: boolean;
  /** What the shell's Next does with it: runs the registered save. */
  runCommit(): Promise<void>;
}

export const stepHarness = (segment: StepSegmentMemory = {}): Harness => {
  const real = realHarness({ segment });
  return {
    step: real.host,
    get hasCommit() {
      return real.hasCommit;
    },
    runCommit: () => real.runCommit(),
    get events() {
      return real.calls.map(call => {
        if (call.kind === 'skip') return `skip:${call.why}`;
        if (call.kind === 'busy') return `busy:${String(call.label)}`;
        if (call.kind === 'holdNext') return `holdNext:${String(call.held)}`;
        return call.kind;
      });
    },
  };
};

export { type Call, scripted } from './scripted.ts';
