/** A ferret summary as Ferrets' contract spells it, typed — so a fixture the route could not serve will not compile. */
import { type FerretSummary, FerretSummarySchema } from '@ferretry/core-ferrets/contract';

export const summaryOf = (over: Record<string, unknown> = {}): FerretSummary =>
  FerretSummarySchema.parse({
    id: 's-1',
    name: 'hadi',
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    runtime: 'claude-default',
    model: 'claude-sonnet-5',
    folder: '/work/x',
    state: 'idle',
    createdAt: '2026-11-01T00:00:00.000Z',
    stateAt: '2026-11-01T00:00:00.000Z',
    ...over,
  });
