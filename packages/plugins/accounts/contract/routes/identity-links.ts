import { z } from 'zod';
import { AccountIdSchema, SignInIdSchema } from './account-ids.ts';
import { InstantSchema } from './foreign.ts';
import { MAX_LOGIN_ENTRIES, oneLine } from './login-entries.ts';

/**
 * THE ACCOUNT → BROWSER-IDENTITY GRAPH (W-124). An EDGE says "sign-in S is live in browser identity I, seen at T".
 * Accounts' own `method.via` edge says "S signs in through provider account G"; following both gives the chain
 * "GitHub → via Google G → identity `work`". Accounts owns the edges because it owns sign-ins; Browsers owns the
 * identity KEYS (`IdentityKeySchema`) and only reports facts.
 *
 * A record holds keys, ids and times, never a value, a cookie or a page's text.
 */

/**
 * A browser identity's key, spelled as Browsers owns it (`BROWSER_IDENTITY_KEY_PATTERN`). A plugin contract may not
 * import another's (`contract-graph`), so the pattern is held here and a test pins the two to one source
 * (`tests/unit/wire/identity-links.test.ts`): a key that is not a folder-safe short name cannot enter the graph.
 */
export const IDENTITY_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
export const IdentityKeySchema = z.string().regex(IDENTITY_KEY_PATTERN);

/** How an edge came to be known: a saved fill that worked, a round trip through the provider, or the owner's word. */
const IdentityLinkHowSchema = z.enum(['filled', 'provider-round-trip', 'owner']);

/** One edge: sign-in `signIn` is live in `identity`. A sign-in may be live in several identities, never twice in one. */
const IdentityLinkSchema = z.strictObject({
  signIn: SignInIdSchema,
  identity: IdentityKeySchema,
  seenAt: InstantSchema,
  how: IdentityLinkHowSchema,
  /** The last time a page showed this sign-in signed OUT in this identity (recovery's trigger). */
  lastSeenSignedOut: InstantSchema.optional(),
});
export type IdentityLink = z.infer<typeof IdentityLinkSchema>;

const MAX_IDENTITY_LINKS = 1_024;
export const MAX_IDENTITY_LINK_PROPOSALS = 32;
export const IDENTITY_LINK_WHY_MAX_LENGTH = 300;

/** A ferret's word that "S lives in I", held until the owner decides. It is NOT an edge: nothing reads it as one. */
const IdentityLinkProposalSchema = z.strictObject({
  signIn: SignInIdSchema,
  identity: IdentityKeySchema,
  why: oneLine(IDENTITY_LINK_WHY_MAX_LENGTH),
  proposedAt: InstantSchema,
});
export type IdentityLinkProposal = z.infer<typeof IdentityLinkProposalSchema>;

/** `state/accounts/identity-links.json` (format 1, mode 0600). */
export const IdentityLinksDocumentSchema = z.strictObject({
  format: z.literal(1),
  links: z.array(IdentityLinkSchema).max(MAX_IDENTITY_LINKS).readonly(),
  proposals: z.array(IdentityLinkProposalSchema).max(MAX_IDENTITY_LINK_PROPOSALS).readonly().default([]),
});
export type IdentityLinksDocument = z.infer<typeof IdentityLinksDocumentSchema>;

/**
 * Which identity a site's sign-in lives in, as a ferret may read it: the one identity (and the provider accounts the
 * sign-in goes through to reach it), or several identities, or one identity under several accounts, which are NEVER
 * resolved by a silent pick. Absent from a hint: none.
 */
export const IdentityAnswerSchema = z.union([
  z.strictObject({
    identity: IdentityKeySchema,
    /** The provider accounts between the site's sign-in and the identity, nearest first. Empty: it is held directly. */
    via: z.array(AccountIdSchema).max(8).readonly(),
  }),
  /** Several identities hold it. The bound is the one the graph's own edges hold: it can never name more identities than it has. */
  z.strictObject({ ambiguous: z.array(IdentityKeySchema).min(2).max(MAX_IDENTITY_LINKS).readonly() }),
  /** One identity holds it, but under more than one account's sign-in: which account to sign in as is the owner's to say. */
  z.strictObject({
    identity: IdentityKeySchema,
    ambiguousAccounts: z.array(AccountIdSchema).min(2).max(MAX_LOGIN_ENTRIES).readonly(),
  }),
]);
export type IdentityAnswer = z.infer<typeof IdentityAnswerSchema>;
