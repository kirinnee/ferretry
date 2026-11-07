import type { FerretSummary } from '../../../../contract/index.ts';

/** A ferret summary as the daemon answers it, with the fields a test cares about overridden. */
export const ferretOf = (id: string, overrides: Record<string, unknown> = {}): FerretSummary =>
  ({
    id,
    name: 'hadi',
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/work/app',
    state: 'working',
    createdAt: '2026-11-07T10:00:00.000Z',
    stateAt: '2026-11-07T11:00:00.000Z',
    ...overrides,
  }) as FerretSummary;

export const NOW = Date.parse('2026-11-07T12:00:00.000Z');
