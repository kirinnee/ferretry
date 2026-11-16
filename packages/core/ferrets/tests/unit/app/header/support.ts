import type { FerretSummary } from '../../../../contract/index.ts';

/** A ferret as the daemon serves it (`GET /v1/ferrets/:ferretId`), with only the fields a test names changed. */
export const ferretSummary = (id: string, overrides: Partial<FerretSummary> = {}): FerretSummary =>
  ({
    id,
    name: 'hadi',
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    runtime: 'claude-main',
    folder: '/home/kirin/Workspace/liftoff/home-manager',
    state: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    stateAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as FerretSummary;
