/**
 * Ferret-view fixtures for the chat suites (today's `tests/support/sessions.ts`, renamed to the words). Every chat
 * suite needs the same shape; building it once keeps the assertions about the component rather than about the fields
 * a `FerretView` happens to carry.
 */

import type { FerretView } from '@ferretry/core-ferrets/contract';

export interface FerretFixtureOverrides {
  readonly config?: Partial<FerretView['config']>;
  readonly state?: Partial<FerretView['state']>;
  readonly directory?: string;
  readonly journalSequence?: number;
  readonly revive?: FerretView['revive'];
  readonly pinnedAt?: string;
}

/** A running `auto` ferret, overridable field by field. */
export const ferretView = (id: string, overrides: FerretFixtureOverrides = {}): FerretView =>
  ({
    config: {
      id,
      name: `Ferret ${id}`,
      agent: 'claude',
      harness: 'claude',
      modelHint: 'claude-opus-5',
      mode: 'auto',
      cwd: `/work/${id}`,
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:01.000Z',
      ...overrides.config,
    },
    state: {
      id,
      status: 'running',
      turn: 4,
      lastActivityAt: '1970-01-01T00:00:01.000Z',
      ...overrides.state,
    },
    directory: overrides.directory ?? `/work/${id}`,
    ...(overrides.journalSequence === undefined ? {} : { journalSequence: overrides.journalSequence }),
    ...(overrides.revive === undefined ? {} : { revive: overrides.revive }),
    ...(overrides.pinnedAt === undefined ? {} : { pinnedAt: overrides.pinnedAt }),
  }) as unknown as FerretView;
