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

/**
 * The owner's own amendment of `accounts.yaml`, through the kernel's one config writer (today's configuration
 * service): only the changed top-level keys are patched, so comments survive, and Gate's judge decides whether it is
 * in effect now or held. A file that does not check is refused for `refuse`, and left alone for `record` (the account
 * act still stands; the status warning says the line did not follow).
 */
export class KernelAccountDefaultsWriter implements AccountDefaultsWriter {
  constructor(
    private readonly config: Pick<ConfigPort, 'file' | 'fileState' | 'write'>,
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
    const outcome = await this.config.write(this.def, undefined, {
      patch: { sites: after.sites, projects: after.projects, folders: after.folders },
    });
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
      case 'refused':
        throw new AccountDefaultsFileBroken(issuesOf(outcome));
    }
  }
}
