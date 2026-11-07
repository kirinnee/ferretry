/** A ferret as the shell lists it (`FerretView`): its config and its state, overridable field by field. */

import type { FerretView } from '../../../app/shell.ts';

export interface FerretFixtureOverrides {
  readonly config?: Record<string, unknown>;
  readonly state?: Record<string, unknown>;
}

/** A working ferret. */
export const ferretView = (id: string, overrides: FerretFixtureOverrides = {}): FerretView => ({
  config: { id, name: `Ferret ${id}`, cwd: `/work/${id}`, ...overrides.config },
  state: { id, state: 'working', ...overrides.state },
});
