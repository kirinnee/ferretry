import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { FerretIdSchema } from '../ids.ts';

/** `tokens.json`: SHA-256 digests of each ferret's `fys_` token, never a token (Gate asks through `bearers:ferret`). */
export const FerretTokensSchema = z.strictObject({
  format: z.literal(1),
  tokens: z.array(
    z.strictObject({
      ferret: FerretIdSchema,
      digest: z.string().regex(/^[0-9a-f]{64}$/u),
      issuedAt: z.string().min(1),
      revoked: z.literal(true).optional(),
      cutOff: z.literal(true).optional(),
    }),
  ),
});
export const FerretTokensFile = defineState({
  name: 'tokens',
  path: 'tokens.json',
  store: 'json',
  format: 1,
  schema: FerretTokensSchema,
  mode: 0o600,
});
