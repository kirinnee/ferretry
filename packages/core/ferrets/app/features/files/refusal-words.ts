/**
 * The sentences a refused file read shows. The grant vocabulary belongs to Access (its app half is not ported yet), so
 * this is the smallest local copy of its `filesystem` wording, never the whole table.
 *
 * GAP(access): drop this file for Access' `grantRefusalNotice` once its app half publishes the grant vocabulary.
 */

/** The refusals a grant can answer with, by the code the daemon puts on its 403/503. */
type Refusal = 'not-granted' | 'device-not-granted' | 'step-up-required' | 'undetermined';

const REFUSAL_BY_CODE: Readonly<Record<string, Refusal>> = {
  grant_not_granted: 'not-granted',
  grant_step_up_required: 'step-up-required',
  grant_device_not_granted: 'device-not-granted',
  grant_undetermined: 'undetermined',
  grants_undetermined: 'undetermined',
  grant_forbidden: 'not-granted',
};

const EXPLANATION: Readonly<Record<Refusal, string>> = {
  'not-granted':
    'The operator of this machine switched off the project filesystem for paired devices, this browser included. It is turned back on at the machine with `fy`.',
  'device-not-granted':
    'This machine allows the project filesystem, but this device has not been given it. Widen this device at the machine with `fy device grant <device> filesystem --use`, or from a device that holds it and can configure pairing.',
  'step-up-required':
    'Using or changing the project filesystem from here needs your passkey. Confirm on this device and it goes ahead.',
  undetermined:
    'This daemon could not read its own grant document, so it is refusing everything governed by it. Nothing is broken about this browser; the document on the host needs repairing.',
};

export interface FailureFields {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

const fieldsOf = (failure: unknown): FailureFields | null =>
  typeof failure === 'object' && failure !== null ? (failure as FailureFields) : null;

/** The sentence for a grant refusal (its explanation, then the daemon's own words), or `null` for any other failure. */
export const grantRefusalSentence = (failure: unknown): string | null => {
  const fields = fieldsOf(failure);
  if (fields === null || typeof fields.code !== 'string') return null;
  const refusal = REFUSAL_BY_CODE[fields.code];
  if (refusal === undefined) return null;
  // A grant refusal is a 403, or a 503 when the daemon cannot read its own grant document.
  if (fields.status !== 403 && fields.status !== 503) return null;
  const detail = typeof fields.message === 'string' ? fields.message : '';
  return detail === '' ? EXPLANATION[refusal] : `${EXPLANATION[refusal]} ${detail}`;
};
