/**
 * `config/account-defaults.yaml` as the owner's account acts use it (docs/config-files.md): one line written
 * (`PUT /v1/accounts/defaults`), the lines an account's delete, merge or rename moves, and the warnings for a line the
 * daemon cannot make sense of.
 *
 * EVERY CHANGE TO THE FILE IS HELD for the owner when anyone else makes it (`configLoosening`), because the card says
 * "Default for ferretry" in the owner's name. The two doors in this class are the owner's own acts, so they are
 * written with `writeOwn` and are in effect at once; a ferret's suggestion waiting in the same file is neither put
 * into effect nor dropped by them — the owner's change is made to BOTH the held text and the version in effect, as the
 * Warden's settings are.
 */
import { checkConfigFile, readConfigText, renderConfigFile } from '@ferretry/fleet';
import {
  type AccountDefaultLine,
  type AccountDefaultsFile,
  type AccountDefaultsRepoint,
  type AccountId,
  accountDefaultLines,
  accountDefaultScopeWords,
  type ConfigFileAddress,
  type ConfigIssue,
  configFilePath,
  placeKeys,
  type ProjectInfo,
  repointAccountDefaults,
  withAccountDefault,
} from '@ferretry/protocol';
import type { ConfigFilesService, ConfigSnapshot } from '../config-files/index.ts';
import type { AccountListing } from './accounts.ts';

const DEFAULTS_FILE: ConfigFileAddress = { kind: 'accountDefaults' };
const DEFAULTS_PATH = configFilePath(DEFAULTS_FILE);

/** The file is there but does not check: an owner act will not write over a file somebody is still fixing. */
export class AccountDefaultsFileBroken extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(`${DEFAULTS_PATH} does not check, so it was not changed; fix it first`);
    this.name = 'AccountDefaultsFileBroken';
  }
}

export interface AccountDefaultsDeps {
  readonly config: Pick<ConfigFilesService, 'inEffect' | 'load' | 'writeOwn'>;
  /** The registered board projects, to say which `projects:` line names none or more than one. */
  readonly projects?: () => Promise<readonly ProjectInfo[]>;
}

export class AccountDefaults {
  constructor(private readonly deps: AccountDefaultsDeps) {}

  /** The lines in effect: the last good version, and the tighter one while an edit waits for the owner. */
  async inEffect(): Promise<AccountDefaultsFile> {
    return (await this.deps.config.inEffect()).evaluation.effective.accountDefaults;
  }

  /** The owner sets the line at `at` to `account`, or removes it with `null`. Answers the lines in effect after. */
  async set(
    at: Pick<AccountDefaultLine, 'scope' | 'within' | 'key'>,
    account: AccountId | null,
  ): Promise<AccountDefaultsFile> {
    return await this.change(file => withAccountDefault(file, at, account));
  }

  /** The owner's account act changed handles: the lines follow, in the same act. */
  async repoint(changes: readonly AccountDefaultsRepoint[]): Promise<void> {
    await this.change(file => repointAccountDefaults(file, changes));
  }

  /** `edit` applied to the version in effect and, when a ferret's edit is held, to the held text too. */
  private async change(edit: (file: AccountDefaultsFile) => AccountDefaultsFile): Promise<AccountDefaultsFile> {
    const { files, evaluation } = await this.deps.config.load();
    const disk = files.get(DEFAULTS_PATH)?.text;
    if (disk !== undefined) {
      const checked = checkConfigFile(DEFAULTS_PATH, disk);
      if (!checked.ok) throw new AccountDefaultsFileBroken(checked.issues);
    }
    const effective = evaluation.effective.accountDefaults;
    const held = disk !== undefined && evaluation.pending.some(pending => pending.path === DEFAULTS_PATH);
    if (!held) {
      const text = renderConfigFile(DEFAULTS_PATH, DEFAULTS_FILE, edit(effective), disk);
      if (text !== undefined) await this.deps.config.writeOwn(DEFAULTS_PATH, text);
      return edit(effective);
    }
    const heldFile = (checkConfigFile(DEFAULTS_PATH, disk) as { readonly value: AccountDefaultsFile }).value;
    const accepted = evaluation.accepted[DEFAULTS_PATH]?.text;
    const text = renderConfigFile(DEFAULTS_PATH, DEFAULTS_FILE, edit(heldFile), disk);
    const inEffect = renderConfigFile(DEFAULTS_PATH, DEFAULTS_FILE, edit(effective), accepted) ?? accepted ?? '';
    if (text !== undefined) await this.deps.config.writeOwn(DEFAULTS_PATH, text, inEffect);
    return edit(effective);
  }

  /**
   * A warning for each line in effect that the daemon cannot use — an account that does not exist, one with no
   * sign-in on that key, a project that is not registered or is named by two. Such a line is ignored (the card falls
   * to the next rule); the warning tells the owner why a default does nothing.
   */
  async warnings(listing: AccountListing, read: ConfigSnapshot): Promise<readonly ConfigIssue[]> {
    const file = read.evaluation.effective.accountDefaults;
    const lines = accountDefaultLines(file);
    if (lines.length === 0) return [];
    const projects = lines.some(line => line.scope === 'projects') ? await this.deps.projects?.() : undefined;
    const handles = new Set(listing.accounts.map(account => account.id));
    const keysOf = (handle: string): ReadonlySet<string> =>
      new Set(listing.signIns.filter(signIn => signIn.account === handle).flatMap(signIn => placeKeys(signIn.place)));
    const pending = read.evaluation.pending.some(item => item.path === DEFAULTS_PATH);
    const located = pending ? undefined : readConfigText(read.files.get(DEFAULTS_PATH)?.text ?? '');
    const issues: ConfigIssue[] = [];
    for (const line of lines) {
      const problem = problemWith(line, handles, keysOf, projects);
      if (problem === undefined) continue;
      const path =
        line.scope === 'sites' ? [line.scope, line.key] : [line.scope, line.within ?? '', line.key];
      const position = located?.ok === true ? located.read.locate(path) : undefined;
      issues.push({
        path: DEFAULTS_PATH,
        ...(position === undefined ? {} : { line: position.line, column: position.column }),
        severity: 'warning',
        message: `${line.key} in ${accountDefaultScopeWords(line)}: ${problem.message}; this line is ignored`,
        fix: problem.fix,
      });
    }
    return issues;
  }
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
