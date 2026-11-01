import {
  LOGIN_OBSERVED_MAX,
  LOGIN_RECIPE_PROPOSALS_MAX,
  LoginDomainSchema,
  LoginMethodSchema,
  LoginObservedSchema,
  LoginRecipeProposalSchema,
  TotpParametersSchema,
} from '../../src/lib/index.ts';
import { z } from 'zod';

/**
 * A FROZEN COPY of the daemon's version 1 index schema (`packages/daemon/src/lib/secrets/logins.ts`,
 * `LoginIndexDocumentSchema`, as of v4.184.0). It is what an OLDER daemon parses `login-entries.json` with, so it must
 * not change when the daemon's does: the test that reads a version 2 index with it proves an older daemon fails
 * closed (damaged) rather than reading the new file as empty.
 */
const SEALED_NAME = /^L[0-9A-F]{24}_(?:PASSWORD|TOTP)_[0-9A-F]{8}$/u;

const LoginRecordV1Schema = z.strictObject({
  key: z.string().regex(/^L[0-9A-F]{24}$/u),
  label: z.string().min(1).max(80),
  match: z.array(z.string().min(1).max(320)).max(16),
  method: LoginMethodSchema.optional(),
  domains: z.array(LoginDomainSchema).max(16).optional(),
  username: z.string().min(1).max(256).optional(),
  seals: z.strictObject({
    password: z.string().regex(SEALED_NAME).optional(),
    totp: z.string().regex(SEALED_NAME).optional(),
  }),
  totp: TotpParametersSchema.optional(),
  recipe: z.string().min(1).max(4_000).optional(),
  autoApplyRecipe: z.literal(true).optional(),
  recipeBy: z.literal('ferret').optional(),
  observed: z.array(LoginObservedSchema).max(LOGIN_OBSERVED_MAX).optional(),
  proposals: z.array(LoginRecipeProposalSchema).max(LOGIN_RECIPE_PROPOSALS_MAX).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const FrozenLoginIndexV1Schema = z.strictObject({
  v: z.literal(1),
  entries: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u), LoginRecordV1Schema),
});
