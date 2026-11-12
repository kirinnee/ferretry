/**
 * What a folder's own Claude settings may not do to a runtime's login (#1587).
 *
 * Claude Code ranks a project's `.claude/settings*.json` `env` above the process environment. A login's LITERAL
 * variables are pinned in the runtime's `--settings` overlay, which outranks the project; a variable left to the
 * process environment (one that names `${secret:}`, or a bare `$OTHER` reference resolved when the wrapper runs) is
 * not, so a repository that sets that key under `env` would start the runtime signed out and the ferret would sit on
 * "Not logged in". The start is refused instead, naming the file and the key, never a value.
 *
 * FAIL CLOSED. A settings file nobody could look for could be the one that blanks the login, so a folder whose
 * repository layout cannot be proved refuses the start with {@link FolderSettingsUnreadableError}, with the reason.
 *
 * Pure but for the injected reader ({@link FolderSettingsVariables}; its adapter is `adapters/folder-claude-settings-file.ts`).
 */

/**
 * The environment variables the Claude settings files that apply to a launch folder set, by file: the folder's own
 * two, the repository root's local file, the main checkout's in a worktree. `file` is a path (relative to the folder
 * when inside it). NAMES ONLY: the value of a project's setting is not this daemon's business and never leaves the adapter.
 */
export interface FolderSettingsVariables {
  variables(cwd: string): Promise<readonly { readonly file: string; readonly names: readonly string[] }[]>;
}

/** Raised when a folder's own settings set a variable this runtime takes from the secret store or the environment. */
export class FolderSettingsOverrideError extends Error {
  constructor(
    readonly file: string,
    readonly variable: string,
    readonly runtime: string,
  ) {
    super(
      `this folder's settings file ${file} sets ${variable}, which overrides runtime ${runtime}'s login (it takes ${variable} from the secret store or the host environment), so it would start signed out. Remove ${variable} from ${file}, or keep it out of the secret store.`,
    );
    this.name = 'FolderSettingsOverrideError';
  }
}

/**
 * Raised when the settings a launch folder's repository keeps cannot be looked for, so the start is refused rather than
 * going ahead unchecked: a settings file that was never read could be the one that blanks the login.
 */
export class FolderSettingsUnreadableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'FolderSettingsUnreadableError';
  }
}

/** What the check reads of a published account. */
export interface FolderCheckedAccount {
  readonly runtime: string;
  readonly kind: 'claude' | 'codex';
  /** The variables that name a secret (the manifest's `secretEnv` keys). */
  readonly secretEnvNames: readonly string[];
  /** The variables that are a bare `$OTHER` reference (the manifest's `referencedEnv`). */
  readonly referencedEnv?: readonly string[] | undefined;
}

/**
 * Throws {@link FolderSettingsOverrideError} when a settings file that applies to `cwd` sets a variable the runtime's
 * login leaves to the process environment. EVERY such variable counts, a `${secret:}` one and a bare `$OTHER` one alike,
 * because neither is pinned in a settings file. Nothing is checked for a Codex runtime, for a login that leaves nothing
 * to the process environment, or when there is no folder to look at.
 */
export async function assertFolderLeavesLoginAlone(input: {
  readonly account: FolderCheckedAccount;
  readonly cwd: string | undefined;
  readonly folderSettings: FolderSettingsVariables | undefined;
}): Promise<void> {
  const { account, cwd, folderSettings } = input;
  const taken = new Set([...account.secretEnvNames, ...(account.referencedEnv ?? [])]);
  if (account.kind !== 'claude' || taken.size === 0 || cwd === undefined || folderSettings === undefined) return;
  for (const { file, names } of await folderSettings.variables(cwd)) {
    const clash = names.find(variable => taken.has(variable));
    if (clash !== undefined) throw new FolderSettingsOverrideError(file, clash, account.runtime);
  }
}
