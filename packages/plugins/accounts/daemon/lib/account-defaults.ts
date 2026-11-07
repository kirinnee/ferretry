/**
 * `config/accounts.yaml` (today's `config/account-defaults.yaml`) as the owner's account acts use it
 * (docs/config-files.md): one line written (`PUT /v1/accounts/defaults`), the lines an account's delete, merge or
 * rename moves, and the warnings for a line the daemon cannot make sense of.
 *
 * EVERY CHANGE TO THE FILE IS HELD for the owner when anyone else makes it, because the card says "Default for
 * ferretry" in the owner's name. The two doors in this class are the owner's own acts, so they are written as the
 * owner's own amendment and are in effect at once (S79).
 *
 * The lines are READ through the kernel's config port. The owner's own amendment is the kernel's config write
 * (`ConfigPort.write`), behind the {@link AccountDefaultsWriter} injected here.
 */
import {
  type AccountDefaultLine,
  type AccountDefaultsFile,
  type AccountDefaultsRepoint,
  type AccountId,
  accountDefaultLines,
  accountDefaultScopeWords,
  placeHosts,
  repointAccountDefaults,
  withAccountDefault,
} from '../../contract/routes/index.ts';
import type { AccountListing } from './accounts.ts';
import type { ProjectInfo } from './sign-in-context.ts';

/** The file's path under `config/`, as every sentence names it. */
export const DEFAULTS_PATH = 'accounts.yaml';

/** One thing wrong with a line, as a status warning says it (today's `ConfigIssue`). */
export interface ConfigIssue {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly fix?: string;
}

/** The file is there but does not check: an owner act will not write over a file somebody is still fixing. */
export class AccountDefaultsFileBroken extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(`${DEFAULTS_PATH} does not check, so it was not changed; fix it first`);
    this.name = 'AccountDefaultsFileBroken';
  }
}

/** The line cannot be written: the account does not exist, or has no sign-in on that key. */
export class AccountDefaultNotUsable extends Error {
  constructor(
    readonly account: string,
    readonly key: string,
  ) {
    super(`${account} has no sign-in on ${key}, so it cannot be its default; add that sign-in first`);
    this.name = 'AccountDefaultNotUsable';
  }
}

/**
 * The owner's own amendment of the file: `edit` applied to the lines in effect, and to a ferret's held suggestion too
 * when one waits, as ONE queued step of the configuration service. A file that does not check is refused when `broken`
 * is `refuse` (raising {@link AccountDefaultsFileBroken}) and only the version in effect is corrected when `record`.
 */
export interface AccountDefaultsWriter {
  amend(edit: (file: AccountDefaultsFile) => AccountDefaultsFile, broken: 'refuse' | 'record'): Promise<void>;
}

export interface AccountDefaultsDeps {
  /** The lines in effect: what the owner confirmed, never a ferret's held suggestion. */
  readonly inEffect: () => AccountDefaultsFile | undefined;
  readonly writer: AccountDefaultsWriter;
  /** The accounts and sign-ins, to refuse a line that could never be used. */
  readonly listing: () => Promise<AccountListing>;
  /** The registered board projects, to say which `projects:` line names none or more than one. */
  readonly projects?: () => Promise<readonly ProjectInfo[]>;
}

export class AccountDefaults {
  /** Why the lines could not follow the last account act, until a later change succeeds; said in the status warnings. */
  #failed: string | undefined;

  constructor(private readonly deps: AccountDefaultsDeps) {}

  /**
   * The owner sets the line at `at` to `account`, or removes it with `null` (always allowed). Refuses a line that
   * could never be used — an account that does not exist or has no sign-in on that key — and a file that does not
   * check. Answers the lines in effect AFTER the write, as the daemon now reads them, not as the edit meant them.
   */
  async set(
    at: Pick<AccountDefaultLine, 'scope' | 'within' | 'key'>,
    account: AccountId | null,
  ): Promise<AccountDefaultsFile> {
    if (account !== null && !handlesSigningInOn(await this.deps.listing(), at.key).has(account))
      throw new AccountDefaultNotUsable(account, at.key);
    await this.deps.writer.amend(file => withAccountDefault(file, at, account), 'refuse');
    return this.deps.inEffect() ?? {};
  }

  /**
   * The lines in effect, for the card's order ({@link chosenSignIn}): what the owner confirmed, never a ferret's
   * held suggestion. The file that cannot be read is no lines, so a card is never lost to it.
   */
  async current(): Promise<AccountDefaultsFile> {
    try {
      return this.deps.inEffect() ?? {};
    } catch {
      return {};
    }
  }

  /**
   * The owner's account act changed handles: the lines follow, in the same act. A file that does not check is not
   * written over, but what is in effect is still corrected, so a stale line never outlives its account.
   */
  async repoint(changes: readonly AccountDefaultsRepoint[]): Promise<void> {
    try {
      await this.deps.writer.amend(file => repointAccountDefaults(file, changes), 'record');
      this.#failed = undefined;
    } catch (error) {
      // The account directory keeps the account change and swallows this; the owner reads it in the status instead.
      this.#failed = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * A warning for each line in effect that the daemon cannot use — an account that does not exist, one with no
   * sign-in on that key, a project that is not registered or is named by two. Such a line is ignored (the card falls
   * to the next rule); the warning tells the owner why a default does nothing.
   */
  async warnings(listing: AccountListing): Promise<readonly ConfigIssue[]> {
    const file = this.deps.inEffect() ?? {};
    const lines = accountDefaultLines(file);
    const unfollowed: ConfigIssue[] =
      this.#failed === undefined
        ? []
        : [
            {
              path: DEFAULTS_PATH,
              severity: 'warning',
              message: `the last account change could not be followed in ${DEFAULTS_PATH} (${this.#failed}); a line may name an account that is gone or was replaced`,
              fix: 'check the lines in this file, or set them again; the next account change or default you set retries',
            },
          ];
    if (lines.length === 0) return unfollowed;
    const projects = lines.some(line => line.scope === 'projects') ? await this.deps.projects?.() : undefined;
    const handles = new Set(listing.accounts.map(account => account.id));
    const keysOf = (handle: string): ReadonlySet<string> => keysOfAccount(listing, handle);
    const issues: ConfigIssue[] = [];
    for (const line of lines) {
      const problem = problemWith(line, handles, keysOf, projects);
      if (problem === undefined) continue;
      issues.push({
        path: DEFAULTS_PATH,
        severity: 'warning',
        message: `${line.key} in ${accountDefaultScopeWords(line)}: ${problem.message}; this line is ignored`,
        fix: problem.fix,
      });
    }
    return [...unfollowed, ...issues];
  }
}

/** Every key a sign-in NAMES, its `match` hosts too: a line may sit on a host a site is for, not only one it logs in on. */
const keysOfAccount = (listing: AccountListing, handle: string): ReadonlySet<string> =>
  new Set(listing.signIns.filter(signIn => signIn.account === handle).flatMap(signIn => placeHosts(signIn.place)));

/** The accounts that have a sign-in on `key`. */
function handlesSigningInOn(listing: AccountListing, key: string): ReadonlySet<string> {
  return new Set(listing.accounts.map(account => account.id).filter(handle => keysOfAccount(listing, handle).has(key)));
}

function problemWith(
  line: AccountDefaultLine,
  handles: ReadonlySet<string>,
  keysOf: (handle: string) => ReadonlySet<string>,
  projects: readonly ProjectInfo[] | undefined,
): { readonly message: string; readonly fix: string } | undefined {
  if (!handles.has(line.account))
    return {
      message: `${line.account} is not an account`,
      fix: 'name an account that exists (`fy account ls`), or remove the line',
    };
  if (!keysOf(line.account).has(line.key))
    return {
      message: `${line.account} has no sign-in on ${line.key}`,
      fix: `add that sign-in to ${line.account}, or point the line at an account that signs in there`,
    };
  if (line.scope === 'projects' && projects !== undefined) {
    const within = line.within ?? '';
    if (projects.some(project => project.id === within)) return undefined;
    const named = projects.filter(project => project.name === within);
    if (named.length === 0)
      return { message: `no project is named ${within}`, fix: 'name a project by its id or its exact name' };
    if (named.length > 1)
      return { message: `more than one project is named ${within}`, fix: 'name the project by its id instead' };
  }
  return undefined;
}
