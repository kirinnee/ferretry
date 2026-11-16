/** A selection that names every component: for the harness tests that are not about which components a runtime selects. */
import type { SelectedComponents } from '@ferretry/plugin-runtimes/contract';

const EVERYTHING = { has: () => true } as unknown as ReadonlySet<string>;

export const selectEverything = async (): Promise<SelectedComponents> => ({
  settings: EVERYTHING,
  hooks: EVERYTHING,
});

/** A selection of exactly these settings names (B02). */
export const selectSettings =
  (...names: string[]) =>
  async (): Promise<SelectedComponents> => ({ settings: new Set(names), hooks: new Set() });
