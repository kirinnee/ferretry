/**
 * Reading what a token endpoint answered. Pure. (A registration endpoint's answer is `registration.ts`.)
 *
 * NOTHING A PROVIDER SAID IS QUOTED BACK. A token response IS the credential, and an error body is free
 * text a provider may have put anything in, so every refusal here is chosen from a fixed table keyed by
 * the RFC error CODE, and a code this file does not know reads as the generic sentence.
 */

import { MAX_SECRET_VALUE_LENGTH, MIN_SECRET_VALUE_LENGTH } from '@ferretry/protocol';
import { z } from 'zod';

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const TokenValueSchema = z.string().min(MIN_SECRET_VALUE_LENGTH).max(MAX_SECRET_VALUE_LENGTH);

const TokenResponseSchema = z.looseObject({
  access_token: TokenValueSchema,
  token_type: z.string().optional(),
  expires_in: z.number().positive().optional(),
  refresh_token: TokenValueSchema.optional(),
  scope: z.string().max(2048).optional(),
});

const ErrorResponseSchema = z.looseObject({ error: z.string().max(128) });

/** A token endpoint's answer: the tokens, or the RFC 6749 §5.2 error CODE. Never the body. */
export type TokenAnswer =
  | {
      readonly kind: 'tokens';
      readonly accessToken: string;
      readonly refreshToken?: string;
      readonly expiresInSeconds?: number;
      readonly scope?: string;
    }
  | { readonly kind: 'error'; readonly error: string };

/**
 * A successful answer is `200` with a Bearer access token the store can hold (RFC 6749 §5.1). Anything
 * else is an error: its code when the body names one in the RFC shape, `unreadable` when it does not.
 */
export function tokenAnswer(status: number, text: string): TokenAnswer {
  const body = parseJson(text);
  if (status === 200) {
    const parsed = TokenResponseSchema.safeParse(body);
    if (parsed.success && (parsed.data.token_type === undefined || parsed.data.token_type.toLowerCase() === 'bearer'))
      return {
        kind: 'tokens',
        accessToken: parsed.data.access_token,
        ...(parsed.data.refresh_token === undefined ? {} : { refreshToken: parsed.data.refresh_token }),
        ...(parsed.data.expires_in === undefined ? {} : { expiresInSeconds: parsed.data.expires_in }),
        ...(parsed.data.scope === undefined ? {} : { scope: parsed.data.scope }),
      };
    return { kind: 'error', error: 'unreadable' };
  }
  const error = ErrorResponseSchema.safeParse(body);
  return { kind: 'error', error: error.success ? error.data.error : 'unreadable' };
}

const TOKEN_ERRORS: Readonly<Record<string, string>> = {
  invalid_grant:
    'The provider would not accept that sign-in code — it may have been used already or expired. Start again.',
  invalid_client: 'The provider no longer recognises Ferretry’s registration. Start again to register afresh.',
  unauthorized_client: 'The provider does not let Ferretry sign in this way.',
  invalid_scope: 'The provider would not grant the access this server asks for.',
};

/** A token endpoint's refusal, in words. */
export const tokenRefusal = (error: string): string =>
  TOKEN_ERRORS[error] ?? 'The provider did not finish the sign-in. Start again.';
