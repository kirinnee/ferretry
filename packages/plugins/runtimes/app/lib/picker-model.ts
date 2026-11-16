/**
 * One model a picker offers, as the pickers read it. A login's model catalog (`RuntimeModelChoice`) puts it in a tier,
 * gives its window, the efforts it takes and whether the CLI has a fast mode on it.
 */

import type { ModelTier } from '@ferretry/app/ui';

// GAP(accounts): `PickerModel` and `PickerAccount` live in the Accounts app half (account-picker-catalog.ts); this is
// the smallest copy the pickers here read.
export interface PickerModel {
  readonly id: string;
  readonly available: boolean;
  readonly label?: string;
  readonly tier?: ModelTier;
  readonly context?: number;
  /** The reasoning efforts it takes; empty when it takes none. Absent when no catalog says. */
  readonly efforts?: readonly string[];
  readonly defaultEffort?: string;
  /** Whether the CLI offers fast mode on it; absent when the daemon did not say. */
  readonly fast?: boolean;
  /** Installed on this machine, as the local server (Ollama) reported it, rather than listed by the catalog. */
  readonly local?: true;
}
