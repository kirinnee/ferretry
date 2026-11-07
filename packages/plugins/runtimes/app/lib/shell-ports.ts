/**
 * What the runtimes app needs from files that live with another owner's app half, kept as the smallest local
 * copy each (never the whole file) until that owner publishes them through a contract.
 */

import type { GrantRefusal, RuntimeView } from '../../contract/index.ts';

// ─── GAP(access): `grantGuidance` (the grant vocabulary's sentences) is in the Access app half ─────────────────────

/** The sentence a refusal of the `fleet` capability reads as, in the shared grant vocabulary. */
export const fleetRefusalExplanation = (refusal: GrantRefusal): string => {
  switch (refusal) {
    case 'granted':
      return 'The operator allows this.';
    case 'not-granted':
      return 'The operator of this machine switched off the agent fleet for paired devices, this browser included. It is turned back on at the machine with `fy`.';
    case 'device-not-granted':
      return 'This machine allows the agent fleet, but this device has not been given it. Widen this device at the machine with `fy device grant <device> fleet --use`, or from a device that holds it and can configure pairing.';
    case 'step-up-required':
      return 'Using or changing the agent fleet from here needs your passkey. Confirm on this device and it goes ahead.';
    case 'undetermined':
      return 'This daemon could not read its own grant document, so it is refusing everything governed by it. Nothing is broken about this browser; the document on the host needs repairing.';
  }
};

// ─── GAP(ferrets): `FleetApplyAuthority` and `runtimeNameProblem` are in the unplaced fleet UI (apply-change.ts, ───
// ─── runtimes-model.ts) ────────────────────────────────────────────────────────────────────────────────────────────

/** What this browser may do with a change on this machine, from the machine view's `authority`. */
export type FleetApplyAuthority =
  /** Apply now, and nothing else is asked. */
  | { readonly kind: 'open' }
  /** Allowed once this device confirms with its passkey, which the carrier asks for when the daemon does. */
  | { readonly kind: 'step-up' }
  /** Refused for a reason a passkey would not fix — switched off, an unreadable grant document. */
  | { readonly kind: 'refused'; readonly refusal: GrantRefusal }
  /**
   * This browser never learned what it may do here, because the machine read itself failed.
   *
   * DELIBERATELY NOT `refused`: that would put a sentence about the operator's decisions on screen on
   * the strength of no answer at all.
   */
  | { readonly kind: 'unreadable' };

export interface NameProblem {
  readonly message: string;
  /** A name that would work, offered as "Use <suggestion>". */
  readonly suggestion?: string;
}

const NAME_PATTERN = /^[A-Za-z0-9-]+$/u;

/** The first free `<base>`, `<base>-2`, `<base>-3`, … */
export const uniqueName = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${String(index)}`)) index += 1;
  return `${base}-${String(index)}`;
};

/** Letters, digits and dashes only, lower case. */
export const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

/** Why a runtime name cannot be used, or `null` (R1, E16). */
export const runtimeNameProblem = (
  name: string,
  runtimes: readonly RuntimeView[],
  machineName: string,
): NameProblem | null => {
  const taken = new Set(runtimes.map(runtime => runtime.name));
  if (name === '') return { message: 'Give the runtime a name.' };
  if (!NAME_PATTERN.test(name))
    return { message: 'Use only letters, digits and dashes.', suggestion: uniqueName(slug(name) || 'runtime', taken) };
  if (taken.has(name))
    return { message: `${name} is already a runtime on ${machineName}.`, suggestion: uniqueName(name, taken) };
  return null;
};
