/** Why a phone approval was refused, in a code a route and a tool branch on and a sentence a person reads. */
export type PhoneApprovalErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'capacity'
  | 'unavailable';

export class PhoneApprovalError extends Error {
  override readonly name = 'PhoneApprovalError';
  constructor(
    readonly code: PhoneApprovalErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The HTTP status each refusal answers with. */
export const PHONE_APPROVAL_STATUS: Readonly<Record<PhoneApprovalErrorCode, number>> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  capacity: 429,
  unavailable: 503,
};
