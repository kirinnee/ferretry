/** A selection that names every component: for the harness tests that are not about which components a runtime selects. */
import type { SelectedComponents } from '@ferretry/plugin-runtimes/contract';

/** Names everything by `has`, and lists nothing: there is no order to a selection of everything. */
const EVERYTHING = {
  has: () => true,
  [Symbol.iterator]: () => [][Symbol.iterator](),
} as unknown as ReadonlySet<string>;

export const selectEverything = async (): Promise<SelectedComponents> => ({
  settings: EVERYTHING,
  hooks: EVERYTHING,
});

/** A selection of exactly these settings names (B02). */
export const selectSettings =
  (...names: string[]) =>
  async (): Promise<SelectedComponents> => ({ settings: new Set(names), hooks: new Set() });
