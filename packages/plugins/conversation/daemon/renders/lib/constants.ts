import { FY_RENDER_LIMITS } from '../../../contract/index.ts';

/**
 * The saved picture's numbers that the contract does not carry (today's `renders.ts`): the id grammar's length bounds
 * and alphabet, the in-flight bound and the largest request body. The kinds, quotas, token and shapes are the
 * contract's (`wire-media.ts`).
 */
export const RENDER_ID_MIN_LENGTH = 6;
export const RENDER_ID_MAX_LENGTH = 52;
/** Lowercase Crockford base32: the digits and the letters but `i`, `l`, `o` and `u`. */
export const RENDER_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * The most a save request body may weigh: the largest payload with JSON's worst escaping (six bytes for one control
 * character) and room for the envelope. The transport bounds the read with it before a byte of the payload is held.
 */
export const RENDER_MAX_BODY_BYTES = FY_RENDER_LIMITS.htmlBytes * 6 + 16 * 1024;
