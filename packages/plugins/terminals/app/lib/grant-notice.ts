/**
 * WHAT A GRANT REFUSAL MEANS TO THE READER, for the three places Terminals shows a failed call.
 *
 * The daemon decides; this decides nothing. A governed route answers a refusal with a `grant_*` code (Gate's
 * `grantRefusalCode`) and the daemon's own sentence. The sentence for each reason is Access's (its Devices screen
 * owns the full table); the part Terminals needs is copied here, short and keyed by the same closed set (a test pins
 * it to Gate's `GRANT_REFUSALS` and `grantRefusalCode`, which a half cannot import), so a refused
 * terminal open reads as a refusal with a next step instead of a bare "HTTP 403".
 */

/** Why a governed call was refused: Gate's closed set. */
export type GrantRefusal = 'granted' | 'not-granted' | 'device-not-granted' | 'step-up-required' | 'undetermined';

/** `grant_not_granted`, `grant_device_not_granted`, …: the code a governed route answers with. */
const codeOf = (refusal: GrantRefusal): string => `grant_${refusal.replaceAll('-', '_')}`;

/** What to do next, per reason. `satisfies Record<…>` so a new reason cannot arrive without words. */
export const GRANT_EXPLANATIONS = {
  granted: 'The operator allows this.',
  'not-granted': 'The operator of this machine switched this off. It is turned back on on the host.',
  'device-not-granted':
    'The machine allows this, but this device has not been given it. Widen this device at the machine, or from a device that holds it and can configure pairing.',
  'step-up-required': 'This needs your passkey. Confirm on this device and it goes ahead.',
  undetermined:
    'This daemon could not read its own grant document, so it is refusing everything governed by it. Nothing is broken about this browser; the document on the host needs repairing.',
} as const satisfies Record<GrantRefusal, string>;

const REASON_BY_CODE: ReadonlyMap<string, GrantRefusal> = new Map([
  ...(Object.keys(GRANT_EXPLANATIONS) as GrantRefusal[]).map(reason => [codeOf(reason), reason] as const),
  // Raised by the grant routes rather than by the guard; a reader meets them the same way.
  ['grants_undetermined', 'undetermined'] as const,
  ['grant_forbidden', 'not-granted'] as const,
]);

export interface GrantRefusalNotice {
  readonly refusal: GrantRefusal;
  /** The daemon's own sentence, kept whole: it names the command a person runs. */
  readonly detail: string;
  readonly explanation: string;
}

/**
 * A refusal an ordinary route answered with, or `null` when this failure is about something else.
 *
 * Read structurally rather than by class: the two fields are the whole contract.
 */
export function grantRefusalNotice(error: unknown): GrantRefusalNotice | null {
  if (error === null || typeof error !== 'object') return null;
  const failure = error as { readonly status?: unknown; readonly code?: unknown; readonly message?: unknown };
  if (typeof failure.code !== 'string') return null;
  const refusal = REASON_BY_CODE.get(failure.code);
  if (refusal === undefined) return null;
  // A grant refusal is a 403, or a 503 when the daemon cannot read its own grant document.
  if (failure.status !== 403 && failure.status !== 503) return null;
  const detail = typeof failure.message === 'string' ? failure.message : '';
  return { refusal, detail, explanation: GRANT_EXPLANATIONS[refusal] };
}
