/** `launch.parts`: a ferret in a project linked to a Git account gets that account's agent and git settings (r9 B4). */
import type { LaunchPart, LaunchPartSource } from '@ferretry/core-ferrets/contract';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import type { GitAccount, GitAccountId } from '../../../contract/index.ts';
import { accountForFolder } from '../../lib/account-for-folder.ts';
import { type AccountKit, gitEnvironment } from './environment.ts';

const GIT_ACCOUNTS_PLUGIN = 'git-accounts';

export interface AccountLaunchDeps {
  /** The registered projects; empty when Projects is not there (a ferret then gets nothing). */
  projects(): Promise<readonly ProjectInfo[]>;
  accounts(): Promise<readonly GitAccount[]>;
  /** The account's agent and files, started on first ask; `undefined` when it has no key Ferretry made. */
  kit(account: GitAccountId): Promise<AccountKit | undefined>;
}

/**
 * Only a folder inside a project that is linked to an account that exists, and only an account with a key Ferretry
 * made, is given anything: elsewhere the launch is exactly what it was. A source that cannot answer is skipped (the
 * ferret starts, without the account), because it is an addition and never a reason to refuse a start.
 */
export function accountLaunchParts(deps: AccountLaunchDeps): LaunchPartSource {
  return {
    async parts(spec): Promise<readonly LaunchPart[]> {
      const projects = await deps.projects();
      if (projects.length === 0) return [];
      const accounts = await deps.accounts();
      const found = accountForFolder(spec.folder, projects, id => accounts.some(account => account.id === id));
      const account = accounts.find(each => each.id === found?.account);
      if (account === undefined) return [];
      const kit = await deps.kit(account.id);
      if (kit === undefined || (!kit.auth && !kit.signing)) return [];
      return [{ kind: 'pane-env', plugin: GIT_ACCOUNTS_PLUGIN, env: gitEnvironment(account, kit) }];
    },
  };
}
