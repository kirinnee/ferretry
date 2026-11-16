import type { ConfigFileDef, ConfigPort, ConfigWriteOutcome } from '@ferretry/kernel/contract';
import type { AccountsConfig } from '../../contract/index.ts';
import type { AccountDefaultsFile } from '../../contract/routes/index.ts';
import {
  AccountDefaultsFileBroken,
  type AccountDefaultsWriter,
  type ConfigIssue,
  DEFAULTS_PATH,
} from '../lib/account-defaults.ts';

/** The write did not go into effect: held for the owner, or the file moved under it. Its words are the kernel's. */
export class AccountDefaultsNotWritten extends Error {
  constructor(
    readonly outcome: 'held' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'AccountDefaultsNotWritten';
  }
}

const issuesOf = (outcome: Extract<ConfigWriteOutcome, { kind: 'refused' }>): readonly ConfigIssue[] =>
  outcome.issues.map(issue => ({
    path: DEFAULTS_PATH,
    ...(issue.line === undefined ? {} : { line: issue.line }),
    severity: 'error' as const,
    message: issue.message,
  }));

const SECTIONS = ['sites', 'projects', 'folders'] as const;

/**
 * Only the lines `after` changes from `before`, as a patch that merges each section into the file's own mapping
 * (`within`): a line the owner removed is `undefined`, one it set is its new value, every other line is not named.
 */
function changedLines(
  before: AccountDefaultsFile,
  after: AccountDefaultsFile,
): { readonly patch: Record<string, unknown>; readonly within: readonly string[] } {
  const patch: Record<string, unknown> = {};
  for (const section of SECTIONS) {
    const was = (before[section] ?? {}) as Record<string, unknown>;
    const now = (after[section] ?? {}) as Record<string, unknown>;
    const changed = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(
      line => JSON.stringify(was[line]) !== JSON.stringify(now[line]),
    );
    if (changed.length > 0) patch[section] = Object.fromEntries(changed.map(line => [line, now[line]]));
  }
  return { patch, within: Object.keys(patch) };
}

/**
 * The owner's own amendment of `accounts.yaml`, through the kernel's one config writer (today's configuration
 * service): only the changed top-level keys are patched, so comments survive, and Gate's judge decides whether it is
 * in effect now or held. A file that does not check is refused for `refuse`, and left alone for `record` (the account
 * act still stands; the status warning says the line did not follow).
 */
export class KernelAccountDefaultsWriter implements AccountDefaultsWriter {
  constructor(
    private readonly config: Pick<ConfigPort, 'file' | 'fileState' | 'writeAsOwner'>,
    private readonly def: ConfigFileDef<AccountsConfig>,
  ) {}

  async amend(edit: (file: AccountDefaultsFile) => AccountDefaultsFile, broken: 'refuse' | 'record'): Promise<void> {
    const status = this.config.fileState(this.def);
    if (status.state === 'invalid')
      throw new AccountDefaultsFileBroken(
        broken === 'refuse'
          ? status.sentences.map(message => ({ path: DEFAULTS_PATH, severity: 'error' as const, message }))
          : [],
      );
    const before: AccountDefaultsFile = this.config.file(this.def) ?? {};
    const after = edit(before);
    // The owner's patch: made to BOTH versions of a file with a ferret's edit held, so the owner's line is in effect at
    // once and the ferret's suggestion stays held rather than riding into effect with it (docs/config-files.md rule 3).
    // Beside a held edit only the lines the owner changed are sent, each section merged line by line, so the held
    // version keeps the lines it has of its own; with nothing held the whole sections are written as before.
    const outcome = await this.config.writeAsOwner(
      this.def,
      undefined,
      status.state === 'held'
        ? changedLines(before, after)
        : { patch: { sites: after.sites, projects: after.projects, folders: after.folders } },
    );
    switch (outcome.kind) {
      case 'written':
        return;
      case 'held':
        throw new AccountDefaultsNotWritten(
          'held',
          `${DEFAULTS_PATH} was changed but waits for the owner: ${outcome.sentences.join(' ')}`,
        );
      case 'conflict':
        throw new AccountDefaultsNotWritten('conflict', `${DEFAULTS_PATH} changed while this was written; try again`);
      case 'refused': {
        // The kernel's own words are kept: "does not check" is the wrong diagnosis for a link or a file that is not UTF-8.
        const said = outcome.issues.map(issue =>
          issue.fix === undefined || issue.fix === '' ? issue.message : `${issue.message}: ${issue.fix}`,
        );
        throw new AccountDefaultsFileBroken(issuesOf(outcome), said.length === 0 ? undefined : said.join('; '));
      }
    }
  }
}
