import type { FerretState, FerretSummary } from '../../../../contract/index.ts';
import { ferretId, T0 } from '../../../../contract/testing/index.ts';

export interface SessionSeed {
  readonly id: string;
  readonly name?: string;
  readonly parent?: string;
  /** The ownership label given to start. */
  readonly label?: string;
  readonly status?: FerretState;
}

/** A complete ferret summary so the plan logic is exercised against the real wire shape. */
export function session(seed: SessionSeed): FerretSummary {
  return {
    id: ferretId(seed.id),
    name: seed.name ?? seed.id,
    ...(seed.parent === undefined ? {} : { parent: ferretId(seed.parent) }),
    ...(seed.label === undefined ? {} : { label: seed.label }),
    role: seed.parent === undefined ? 'lead' : 'helper',
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/workspace',
    state: seed.status ?? 'working',
    createdAt: T0,
    stateAt: T0,
  } as FerretSummary;
}

export const ids = (targets: readonly { id: string }[]): string[] => targets.map(target => target.id);
