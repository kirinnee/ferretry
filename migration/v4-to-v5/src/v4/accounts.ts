/**
 * v4 website-account files (4.291.5). A LOCAL copy on purpose: the product has no v4 reader. Envelopes only; every
 * record is checked by the v5 schema it lands under (v5 copied v4's record schemas field for field).
 *
 * - `state/login-entries.json` (`packages/daemon/src/adapters/secrets/file-login-index-store.ts`,
 *   `FileLoginIndexStore`): the account index, `{v: 2, accounts, signIns, migrated?}`
 *   (`AccountIndexDocumentSchema`, `packages/protocol/src/lib/accounts.ts:600`), `0600`. No value: each account names
 *   the sealed names of its password and 2FA seeds. A `v: 1` index (saved logins) is upgraded by v4's boot step
 *   (`AccountStore.prepare`, `lib/secrets/accounts.ts:1223`), which also keeps the v1 bytes once as
 *   `login-entries.v1.json` ("never read by this daemon").
 * - `state/login-secrets.json` (`FileSecretDocumentStore(paths, files, LOGIN_SECRETS_DOCUMENT)`, `bin/fyd.ts:7075`):
 *   `{v: 1, cipher: 'AES-256-GCM', entries: {<sealed name>: {iv, ciphertext, createdAt, updatedAt}}}`, sealed by
 *   `WebCryptoSecretCipher` under `state/secrets.key` (the vault's key) with the entry NAME alone as the AAD. SECRET:
 *   never opened here.
 * - `state/accounts/sign-in-rules.json` (`FileSignInRuleStore`, `adapters/sign-in-rules/file-sign-in-rules.ts`):
 *   `{v: 1, rules: [...]}` (`SignInRulesDocumentSchema`, strict). A damaged file is ZERO rules in v4.
 * - `state/secure-copy/rules.json` (`FilePasteRuleStore`, `adapters/secure-copy/file-paste-rules.ts`):
 *   `{v: 1, rules: [...], settings?}`; an absent `settings` reads as `DEFAULT_PASTE_RULE_SETTINGS`.
 * - Task plans and paste plans, rule suggestions, phone approvals, 2FA seed stages and the sign-in grant ledger are
 *   in memory only in v4 ("a restart forgets them"): nothing on disk.
 */
import { z } from 'zod';

export const V4_LOGIN_ENTRIES = 'state/login-entries.json';
export const V4_LOGIN_ENTRIES_V1_BACKUP = 'state/login-entries.v1.json';
export const V4_LOGIN_SECRETS = 'state/login-secrets.json';
export const V4_SIGN_IN_RULES = 'state/accounts/sign-in-rules.json';
export const V4_PASTE_RULES = 'state/secure-copy/rules.json';

/** The version-2 index's envelope; the records are v5's `AccountIndexDocumentSchema`'s to check. */
export const V4AccountIndexDocument = z.strictObject({
  v: z.literal(2),
  accounts: z.record(z.string(), z.unknown()),
  signIns: z.record(z.string(), z.unknown()),
  /** Written once by v4's v1 → v2 upgrade; no v5 field. */
  migrated: z.unknown().optional(),
});

export const V4SignInRulesDocument = z.strictObject({ v: z.literal(1), rules: z.array(z.unknown()) });

export const V4PasteRulesDocument = z.strictObject({
  v: z.literal(1),
  rules: z.array(z.unknown()),
  settings: z.unknown().optional(),
});
