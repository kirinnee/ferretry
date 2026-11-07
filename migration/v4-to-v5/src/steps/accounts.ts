/**
 * Website accounts: v4's account index, standing sign-in rules, paste rules and sealed values → `state/accounts/`
 * (`packages/plugins/accounts/manifest.ts` `data.state`). Every id is kept exactly: account handles and keys, `si_`
 * sign-ins, `tf_` 2FA keys, `sr_` rules, sealed names.
 *
 * | v4                                   | v5                                    | change                                       |
 * | ------------------------------------ | ------------------------------------- | -------------------------------------------- |
 * | `state/login-entries.json` (`v: 2`)  | `state/accounts/accounts.json`        | `v: 2` → `format: 1`; `migrated` dropped;     |
 * |                                      |                                       | a 2FA key's `addedBy: 'migration'` → `owner` |
 * | `state/login-secrets.json` (sealed)  | `state/accounts/login-secrets.json`   | envelope `v: 1` → `format: 1` only           |
 * | `state/accounts/sign-in-rules.json`  | `state/accounts/sign-in-rules.json`   | `format: 1` stamped first; body unchanged    |
 * | `state/secure-copy/rules.json`       | `state/accounts/copy-rules.json`      | `format: 1` stamped; absent `settings` →     |
 * |                                      |                                       | v4's default, as v4 read it                  |
 *
 * - The index: v5's `AccountIndexDocumentSchema` is v4's version 2 schema with `format: 1` for `v: 2`, no `migrated`
 *   record (v4 wrote it once when it upgraded saved logins; v5 has no field) and one 2FA-key origin: v4's
 *   `migration` (a saved login's seed v4 moved into a 2FA key) is the owner's in v5, the only origin it has. Field
 *   names are v5's unchanged (`sessionId` stays, ferret ids are unchanged), so nothing else is renamed.
 * - The rules: carried as the same JSON values. A rule's body is passkey-signed over canonical JSON, so changing a
 *   byte of it would void the owner's approval; v5 kept the schema verbatim and the `v: 1` inside the body. Device
 *   ids and the daemon id the rules name are carried by the Access and Identity steps. Nothing is widened: the same
 *   rules, the same narrowing, the same counts, and the paste settings v4 read (profile targets off unless on).
 * - SEALED: `login-secrets.json` is sealed under the vault key with the entry name alone as the AAD (v4
 *   `WebCryptoSecretCipher`); v5 opens `LOGIN_SECRETS` through the Vault's sealed-document port with the same key
 *   (`state/vault/vault.key`, moved once by the Vault step, BEFORE this one), the same AAD (`additionalData: ''`)
 *   and stamped entries. So every entry's `iv`, `ciphertext` and stamps move as the same strings and only the
 *   envelope's `v` → `format` changes (outside the AAD), as for MCP. Nothing is decrypted or printed.
 * - A sealed value no account points at is carried as it is: v4 swept those at every start (`AccountStore.prepare`),
 *   and v5's boot step is the same sweep (`daemon/lib/accounts.ts` `prepare`), so v5 removes them at its first start
 *   exactly as v4 would have. A sealed name an account points at that is missing makes both v4 and v5 call the store
 *   damaged and sweep nothing; it is carried as it is and the report says how many.
 */
import { SealedDocumentSchema } from '@ferretry/core-vault/contract';
import {
  AccountIndexDocumentSchema,
  DEFAULT_PASTE_RULE_SETTINGS,
  LOGIN_SECRETS,
  PasteRuleSchema,
  PasteRuleSettingsSchema,
  sealedNamesOf,
  SignInRulesDocumentSchema,
} from '@ferretry/plugin-accounts/contract';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { KeptItem, StepReport } from '../report.ts';
import { rewrapSealed, SealedEnvelopeError } from '../rewrap.ts';
import { failureNote, isRecord, readV4Json, V4InputError } from '../v4/documents.ts';
import {
  V4_LOGIN_ENTRIES,
  V4_LOGIN_ENTRIES_V1_BACKUP,
  V4_LOGIN_SECRETS,
  V4_PASTE_RULES,
  V4_SIGN_IN_RULES,
  V4AccountIndexDocument,
  V4PasteRulesDocument,
  V4SignInRulesDocument,
} from '../v4/accounts.ts';
import type { Step } from './index.ts';

/** Accounts' state folder; the file names are the manifest's own declarations. */
const FOLDER = 'state/accounts';
export const V5_ACCOUNT_INDEX = join(FOLDER, 'accounts.json');
export const V5_LOGIN_SECRETS = join(FOLDER, LOGIN_SECRETS.state.path);
export const V5_SIGN_IN_RULES = join(FOLDER, 'sign-in-rules.json');
export const V5_COPY_RULES = join(FOLDER, 'copy-rules.json');
const V4_VAULT_KEY = 'state/secrets.key';

/**
 * `copy-rules.json`'s body, as v5's `FilePasteRuleStore` parses it (`daemon/adapters/secure-copy/file-paste-rules.ts`,
 * private to the daemon), built from the contract's own parts: `v: 1`, the rules and the settings, all strict.
 */
export const V5CopyRulesBodySchema = z.strictObject({
  v: z.literal(1),
  rules: z.array(PasteRuleSchema),
  settings: PasteRuleSettingsSchema,
});

/** The paths of a v5 refusal, never zod's messages (they may quote a host or a label). */
const where = (error: z.ZodError): string =>
  error.issues.map(issue => (issue.path.length === 0 ? '(top)' : issue.path.join('.'))).join(', ');

/** v4's `migration` origin is the owner's in v5 (the one origin v5 has). Answers the index and how many changed. */
function ownerOrigins(accounts: Readonly<Record<string, unknown>>): {
  readonly accounts: Record<string, unknown>;
  readonly relabelled: number;
} {
  let relabelled = 0;
  const out: Record<string, unknown> = {};
  for (const [handle, account] of Object.entries(accounts)) {
    if (!isRecord(account) || !Array.isArray(account.factors)) {
      out[handle] = account;
      continue;
    }
    out[handle] = {
      ...account,
      factors: account.factors.map((factor: unknown) => {
        if (!isRecord(factor) || factor.addedBy !== 'migration') return factor;
        relabelled += 1;
        return { ...factor, addedBy: 'owner' };
      }),
    };
  }
  return { accounts: out, relabelled };
}

const present = async (path: string): Promise<boolean> => (await lstat(path).catch(() => undefined)) !== undefined;

export const accountsStep: Step = {
  id: 'accounts',
  title: 'Website accounts (index, sign-in and copy rules; sealed values moved with the vault key)',
  owner: ['plugin-accounts'],
  reads: [V4_LOGIN_ENTRIES, V4_SIGN_IN_RULES, V4_PASTE_RULES],
  sealed: [V4_LOGIN_SECRETS],
  notCarried: [
    { what: V4_LOGIN_ENTRIES_V1_BACKUP, why: 'a v4 upgrade backup of the saved-logins index, never read by v4' },
    {
      what: 'the index’s `migrated` record',
      why: 'v4 wrote it once when it upgraded saved logins to accounts; v5 has no field for it',
    },
    { what: `${V4_SIGN_IN_RULES}.damaged-*`, why: 'set-aside copies of a damaged rules file, never read' },
    {
      what: 'task plans, paste plans, rule suggestions, phone approvals, staged 2FA seeds, the sign-in grant ledger',
      why: 'in memory only in v4 (a restart forgets them, so each asks again): nothing on disk',
    },
    {
      what: 'config/account-defaults.yaml',
      why: 'configuration, not state: the Settings step carries it to config/accounts.yaml',
    },
  ],
  async run(ctx): Promise<StepReport> {
    const home = ctx.v4.home;
    const sealed: { file: string; bytes: number }[] = [];
    const base = () => ({ id: this.id, title: this.title, notCarried: this.notCarried, sealed });
    try {
      const notes: string[] = ctx.dryRun ? ['dry run: nothing written'] : [];
      const kept: KeptItem[] = [];

      // ── the index ──────────────────────────────────────────────────────────────────────────────────────────
      const indexValue = await readV4Json(home, join(home, V4_LOGIN_ENTRIES));
      let referenced: ReadonlySet<string> | undefined;
      if (indexValue !== undefined) {
        if (isRecord(indexValue) && indexValue.v === 1)
          throw new V4InputError(
            `${V4_LOGIN_ENTRIES}: is still a version 1 index (saved logins); v4 4.291 upgrades it when its daemon starts, so start v4 once, stop it and convert again`,
          );
        const v4 = V4AccountIndexDocument.safeParse(indexValue);
        if (!v4.success) throw new V4InputError(`${V4_LOGIN_ENTRIES}: is not a v4 account index (v: 2)`);
        const origins = ownerOrigins(v4.data.accounts);
        const index = AccountIndexDocumentSchema.safeParse({
          format: 1,
          accounts: origins.accounts,
          signIns: v4.data.signIns,
        });
        if (!index.success)
          throw new V4InputError(`${V4_LOGIN_ENTRIES}: does not fit the v5 account index at ${where(index.error)}`);
        await ctx.v5.json({ path: V5_ACCOUNT_INDEX, format: 1, schema: AccountIndexDocumentSchema }, index.data);
        referenced = new Set(Object.values(index.data.accounts).flatMap(account => [...sealedNamesOf(account)]));
        const accounts = Object.values(index.data.accounts);
        kept.push(
          { what: 'website accounts', count: accounts.length },
          { what: 'sign-ins', count: Object.keys(index.data.signIns).length },
          { what: '2FA keys', count: accounts.reduce((sum, account) => sum + (account.factors?.length ?? 0), 0) },
        );
        if (origins.relabelled > 0)
          notes.push(
            `${String(origins.relabelled)} 2FA key(s) v4 marked as moved from a saved login are the owner's (v5 has no 'migration' origin)`,
          );
      }

      // ── the sealed values: envelope re-labelled, every entry's bytes kept; never decrypted ───────────────────
      const secrets = await lstat(join(home, V4_LOGIN_SECRETS)).catch(() => undefined);
      let names: ReadonlySet<string> | undefined;
      if (secrets !== undefined) {
        // The entries move unchanged, so they open in v5 only under v4's AAD (the entry name alone), stamped.
        if (LOGIN_SECRETS.additionalData !== '' || !LOGIN_SECRETS.stamped)
          throw new V4InputError(
            `${V4_LOGIN_SECRETS}: v5 Accounts seals with another AAD or shape; a converter update is needed`,
          );
        if (!(await present(join(home, V4_VAULT_KEY))))
          throw new V4InputError(`${V4_LOGIN_SECRETS} exists but the vault key ${V4_VAULT_KEY} that seals it does not`);
        if (ctx.dryRun) sealed.push({ file: V5_LOGIN_SECRETS, bytes: secrets.size });
        else {
          const moved = await rewrapSealed(join(home, V4_LOGIN_SECRETS), ctx.v5.resolve(V5_LOGIN_SECRETS), {
            stamped: LOGIN_SECRETS.stamped,
            schema: SealedDocumentSchema,
          });
          sealed.push({ file: V5_LOGIN_SECRETS, bytes: (await lstat(moved.to)).size });
          names = new Set(moved.names);
          kept.push({ what: 'sealed account values (passwords and 2FA seeds)', count: moved.entries });
        }
      }
      if (referenced !== undefined && (names !== undefined || secrets === undefined)) {
        const held = names ?? new Set<string>();
        const missing = [...referenced].filter(name => !held.has(name)).length;
        const orphans = [...held].filter(name => !referenced.has(name)).length;
        if (missing > 0)
          notes.push(
            `the index names ${String(missing)} sealed value(s) that are not there: v4 and v5 both call that store damaged and sweep nothing, so it is carried as it is`,
          );
        else if (orphans > 0)
          notes.push(
            `${String(orphans)} sealed value(s) no account points at: carried, and v5's first start sweeps them as every v4 start did`,
          );
      }

      // ── standing sign-in rules: the same JSON values, `format` stamped first ─────────────────────────────────
      const rulesValue = await readV4Json(home, join(home, V4_SIGN_IN_RULES));
      if (rulesValue !== undefined) {
        const v4 = V4SignInRulesDocument.safeParse(rulesValue);
        if (!v4.success) throw new V4InputError(`${V4_SIGN_IN_RULES}: is not a v4 sign-in rules document (v: 1)`);
        const rules = SignInRulesDocumentSchema.safeParse(v4.data);
        if (!rules.success)
          throw new V4InputError(
            `${V4_SIGN_IN_RULES}: does not fit v5's sign-in rules at ${where(rules.error)} (v4 held no rule from a file it could not read)`,
          );
        await ctx.v5.stamped({ path: V5_SIGN_IN_RULES, format: 1, schema: SignInRulesDocumentSchema }, rules.data);
        kept.push({ what: 'standing sign-in rules', count: rules.data.rules.length });
      }

      // ── paste rules: `secure-copy/rules.json` → `copy-rules.json` ────────────────────────────────────────────
      const pasteValue = await readV4Json(home, join(home, V4_PASTE_RULES));
      if (pasteValue !== undefined) {
        const v4 = V4PasteRulesDocument.safeParse(pasteValue);
        if (!v4.success) throw new V4InputError(`${V4_PASTE_RULES}: is not a v4 paste rules document (v: 1)`);
        const body = V5CopyRulesBodySchema.safeParse({
          v: 1,
          rules: v4.data.rules,
          // v4 read an absent `settings` as its defaults (`FilePasteRuleStore.read`).
          settings: v4.data.settings ?? DEFAULT_PASTE_RULE_SETTINGS,
        });
        if (!body.success)
          throw new V4InputError(`${V4_PASTE_RULES}: does not fit v5's copy rules at ${where(body.error)}`);
        await ctx.v5.stamped({ path: V5_COPY_RULES, format: 1, schema: V5CopyRulesBodySchema }, body.data);
        kept.push({ what: 'paste (secure copy) rules', count: body.data.rules.length });
      }

      if (kept.length === 0 && sealed.length === 0) notes.push('this home has no website accounts or rules');
      return {
        ...base(),
        status: 'converted',
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
        kept,
      };
    } catch (error) {
      return {
        ...base(),
        status: 'failed',
        note:
          error instanceof SealedEnvelopeError
            ? error.message
            : failureNote(error, 'cannot convert the website accounts'),
        kept: [],
      };
    }
  },
};
