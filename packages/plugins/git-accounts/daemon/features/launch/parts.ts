/** `launch.parts`: a ferret in a project linked to a Git account gets that account's agent and git settings (r9 B4). */
import type { LaunchPart, LaunchPartSource } from '@ferretry/core-ferrets/contract';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import type { GitAccount, GitAccountId } from '../../../contract/index.ts';
import { accountForFolder } from '../../lib/account-for-folder.ts';
import type { GpgKit } from '../gpg-keys/gnupg.ts';
import { type AccountKit, gitEnvironment, noIdentityEnvironment } from './environment.ts';

const GIT_ACCOUNTS_PLUGIN = 'git-accounts';

export interface AccountLaunchDeps {
  /** The registered projects; empty when Projects is not there (a ferret then gets nothing). */
  projects(): Promise<readonly ProjectInfo[]>;
  accounts(): Promise<readonly GitAccount[]>;
  /** The account's agent and files, started on first ask; `undefined` when it has no key Ferretry made. */
  kit(account: GitAccountId): Promise<AccountKit | undefined>;
  /** The account's GPG signing key in its isolated home, started on first ask; `undefined` when it signs another way. */
  gpg?(account: GitAccountId): Promise<GpgKit | undefined>;
}

const KEY_UNAVAILABLE =
  "The Git account key for this project is unavailable: Ferretry could not start it. `git push` over ssh here is given no identity at all (not this machine's own), so it will fail, and commits here are not signed as the GitHub account linked to this project. Do not push; tell the person to open the Git accounts page and try again.";

/**
 * Only a folder inside a project that is linked to an account that exists, and only an account with a key Ferretry
 * made, is given anything: elsewhere the launch is exactly what it was. A key that cannot be started does not refuse the
 * start (this is an addition): the ferret starts with a one-sentence instruction that its account key is unavailable.
 * A source that cannot answer at all is skipped.
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
      let kit: AccountKit | undefined;
      let gpg: GpgKit | undefined;
      try {
        kit = await deps.kit(account.id);
        gpg = await deps.gpg?.(account.id);
      } catch {
        // Without a word the pane would push with the machine's own ssh identity: say so, never why (no error text),
        // and give git no identity to fall back to.
        const none = noIdentityEnvironment(account);
        return [
          { kind: 'instruction', id: 'git-accounts-key-unavailable', text: KEY_UNAVAILABLE },
          ...(Object.keys(none).length === 0
            ? []
            : [{ kind: 'pane-env' as const, plugin: GIT_ACCOUNTS_PLUGIN, env: none }]),
        ];
      }
      if (gpg === undefined && (kit === undefined || (!kit.auth && !kit.signing))) return [];
      return [{ kind: 'pane-env', plugin: GIT_ACCOUNTS_PLUGIN, env: gitEnvironment(account, kit, gpg) }];
    },
  };
}
