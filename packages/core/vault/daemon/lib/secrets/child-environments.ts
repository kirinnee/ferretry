/**
 * The Vault's half of lead decision 9: an environment whose secret values a child needs, as an OPAQUE handle.
 *
 * `mint` files the resolved values in a private table and hands back a handle with no field, no enumeration and no
 * JSON beyond the variable names. Only the kernel's spawn adapter holds the opener (`ChildEnvironmentPort`, bound by
 * the kernel and never handed to a half), and it opens the handle at exec time, so the values go from this table
 * straight into the child's environment. A handle opens ONCE: a spent one, or one this Vault never minted, opens to
 * nothing and the kernel refuses the start rather than running the child without its secrets.
 */

import type { ChildEnvironment, ChildEnvironmentOpener } from '@ferretry/kernel/contract';

export class ChildEnvironments implements ChildEnvironmentOpener {
  /** Keyed by the handle object itself, so a dropped handle takes its values with it. */
  readonly #minted = new WeakMap<object, Readonly<Record<string, string>>>();

  /** A handle over `values`; the handle names the variables and nothing else. */
  mint(values: Readonly<Record<string, string>>): ChildEnvironment {
    const names = Object.freeze(Object.keys(values).sort());
    const handle = Object.freeze({
      names,
      // A handle that reaches a log or a JSON body says which variables it sets, never what they hold.
      toJSON: () => ({ names }),
    });
    this.#minted.set(handle, Object.freeze({ ...values }));
    return handle as unknown as ChildEnvironment;
  }

  /** The values, once; `undefined` for a handle this Vault did not mint or already opened. */
  open(env: ChildEnvironment): Readonly<Record<string, string>> | undefined {
    if (typeof env !== 'object' || env === null) return undefined;
    const values = this.#minted.get(env);
    if (values === undefined) return undefined;
    this.#minted.delete(env);
    return values;
  }
}
