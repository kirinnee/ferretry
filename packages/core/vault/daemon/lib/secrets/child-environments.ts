/**
 * The Vault's half of lead decision 9: an environment whose secret values a child needs, as an OPAQUE handle.
 *
 * `mint` files the resolved values in a private table and hands back a handle with no field, no enumeration and no
 * JSON beyond the variable names. Only the kernel's spawn adapter holds the opener (`ChildEnvironmentPort`, bound by
 * the kernel and never handed to a half), and it opens the handle at exec time, so the values go from this table
 * straight into the child's environment. A handle opens ONCE: a spent one, or one this Vault never minted, opens to
 * nothing and the kernel refuses the start rather than running the child without its secrets.
 *
 * `searchPathOf` (Q7, `kernel.paths.whichFor`) is the one look that does NOT spend a handle: the kernel asks it for the
 * handle's `PATH` so a launch guard can resolve a command on the PATH the child WILL have. It answers exactly the
 * `PATH` key and nothing else, only for a handle minted for one of the plugins the kernel names as this caller's
 * readers, and never a `PATH` built from a `${secret:…}` reference (the Vault resolved it, so it knows).
 */

import type { ChildEnvironment, ChildEnvironmentOpener } from '@ferretry/kernel/contract';

/** Who a handle was minted for, and whether its `PATH` came from a secret reference. */
export interface MintProvenance {
  /** The plugin that asked for the handle (the needer the Vault served). Absent: no plugin may search its PATH. */
  readonly requester?: string;
  /** Whether the `PATH` value as asked held a `${secret:…}` (or `${secret?:…}`) reference. */
  readonly pathFromSecret?: boolean;
}

/** One minted handle's values and provenance. */
interface Minted {
  readonly values: Readonly<Record<string, string>>;
  readonly requester: string | undefined;
  readonly pathFromSecret: boolean;
}

/** The one variable `searchPathOf` ever reads. */
const SEARCH_PATH_VARIABLE = 'PATH';

/** Whether a value as ASKED (before resolution) names a secret in any spelling the Vault resolves, or looks like one. */
export const namesSecret = (value: unknown): boolean => typeof value === 'string' && value.includes('${secret');

export class ChildEnvironments implements ChildEnvironmentOpener {
  /** Keyed by the handle object itself, so a dropped handle takes its values with it. */
  readonly #minted = new WeakMap<object, Minted>();

  /** A handle over `values`; the handle names the variables and nothing else. */
  mint(values: Readonly<Record<string, string>>, provenance: MintProvenance = {}): ChildEnvironment {
    const names = Object.freeze(Object.keys(values).sort());
    const handle = Object.freeze({
      names,
      // A handle that reaches a log or a JSON body says which variables it sets, never what they hold.
      toJSON: () => ({ names }),
    });
    this.#minted.set(handle, {
      values: Object.freeze({ ...values }),
      requester: typeof provenance.requester === 'string' ? provenance.requester : undefined,
      pathFromSecret: provenance.pathFromSecret === true,
    });
    return handle as unknown as ChildEnvironment;
  }

  /** The values, once; `undefined` for a handle this Vault did not mint or already opened. */
  open(env: ChildEnvironment): Readonly<Record<string, string>> | undefined {
    if (typeof env !== 'object' || env === null) return undefined;
    const minted = this.#minted.get(env);
    if (minted === undefined) return undefined;
    this.#minted.delete(env);
    return minted.values;
  }

  /**
   * The handle's `PATH` and nothing else, WITHOUT spending it: `undefined` for a handle this Vault did not mint or
   * already opened, one minted for no plugin or for a plugin not in `readers`, one that sets no `PATH`, and one whose
   * `PATH` was built from a secret reference. Every refusal is the same `undefined`, so no caller learns which.
   */
  searchPathOf(env: ChildEnvironment, readers: readonly string[]): string | undefined {
    if (typeof env !== 'object' || env === null) return undefined;
    const minted = this.#minted.get(env);
    // A handle minted for no plugin has no requester to match, so no reader list reaches it.
    if (minted === undefined || minted.requester === undefined || minted.pathFromSecret) return undefined;
    if (!Array.isArray(readers) || !readers.includes(minted.requester)) return undefined;
    if (!Object.hasOwn(minted.values, SEARCH_PATH_VARIABLE)) return undefined;
    const path = minted.values[SEARCH_PATH_VARIABLE];
    return typeof path === 'string' ? path : undefined;
  }
}
