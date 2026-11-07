import type { FerretSummary } from '../../../../contract/index.ts';
import { ferretId, T0 } from '../../../../contract/testing/index.ts';

/** A ferret summary with the fields a test cares about overridden. */
export function sessionView(overrides: Partial<Omit<FerretSummary, 'id' | 'parent'>> & { id?: string; parent?: string } = {}): FerretSummary {
  const { id = 'ses-1', parent, ...rest } = overrides;
  return {
    id: ferretId(id),
    name: 'wren',
    role: parent === undefined ? 'lead' : 'helper',
    harness: 'claude-code',
    runner: 'tmux',
    runtime: 'claude-alpha',
    folder: '/work/repo',
    state: 'working',
    createdAt: T0,
    stateAt: T0,
    ...(parent === undefined ? {} : { parent: ferretId(parent) }),
    ...rest,
  } as FerretSummary;
}
