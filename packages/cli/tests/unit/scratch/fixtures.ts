import type { ScratchPlanView, ScratchSweepView } from '@ferretry/protocol';
import type { IScratchGateway, IScratchOutput } from '../../../src/lib/scratch/ports.ts';

type EligiblePlan = Extract<ScratchPlanView, { eligible: true }>;
type RetainedPlan = Extract<ScratchPlanView, { eligible: false }>;

export function eligiblePlan(overrides: Partial<EligiblePlan> = {}): EligiblePlan {
  return {
    sessionId: 'session-free',
    teammate: 'Fable',
    directory: '/state/session-free/scratch',
    bytes: 2_500_000,
    entries: [
      { name: 'cache', bytes: 2_000_000, kind: 'directory' },
      { name: 'note.txt', bytes: 500_000, kind: 'file' },
    ],
    eligible: true,
    ...overrides,
  };
}

export function retainedPlan(overrides: Partial<RetainedPlan> = {}): RetainedPlan {
  return {
    sessionId: 'session-live',
    directory: '/state/session-live/scratch',
    bytes: 1_500,
    entries: [],
    eligible: false,
    reason: 'session is still active',
    ...overrides,
  };
}

export class RecordingScratchGateway implements IScratchGateway {
  readonly limits: number[] = [];
  readonly forces: boolean[] = [];

  constructor(
    private readonly plan: ScratchPlanView[] = [eligiblePlan(), retainedPlan()],
    private readonly sweep: ScratchSweepView = { sessions: 1, bytes: 2_500_000, failures: 0 },
  ) {}

  scratchPlan(limit?: number): Promise<ScratchPlanView[]> {
    this.limits.push(limit ?? 20);
    return Promise.resolve(this.plan);
  }

  scratchSweep(force?: boolean): Promise<ScratchSweepView> {
    this.forces.push(force === true);
    return Promise.resolve(this.sweep);
  }
}

export class CapturingOutput implements IScratchOutput {
  readonly messages: string[] = [];

  success(message: string): void {
    this.messages.push(message);
  }
}
