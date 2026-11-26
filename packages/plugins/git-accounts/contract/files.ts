import { type ConfigDef, defineConfig, defineState } from '@ferretry/kernel/contract';
import { defineSealedDocument } from '@ferretry/core-vault/contract';
import { GitAccountsConfigSchema, gitAccountsLoosens } from './config.ts';
import { GitAccountsFileSchema } from './wire.ts';

/** `state/git-accounts/accounts.json`: who is connected, in the clear (no token, no key material). */
export const GitAccountsState = defineState({
  name: 'accounts',
  path: 'accounts.json',
  store: 'json',
  format: 1,
  schema: GitAccountsFileSchema,
});

/**
 * `state/git-accounts/tokens.json`: the OAuth tokens, SEALED (0600, the vault's key). Deliberately NOT the shared
 * `fy secret` list: every agent can `fy secret use` a shared secret, and a GitHub token is too strong for that. Only this
 * plugin's daemon half opens it, and only to place a token on a request to `api.github.com`.
 */
export const GIT_ACCOUNT_TOKENS = defineSealedDocument({ name: 'tokens', path: 'tokens.json' });

/** `config/git-accounts.yaml`. The leaf's `ConfigDef` is invariant in its shape, so the manifest takes the widened def. */
export const GitAccountsConfigFile = defineConfig({
  file: 'git-accounts.yaml',
  schema: GitAccountsConfigSchema,
  axis: 'configure',
  loosens: gitAccountsLoosens,
  personOnly: true,
});
export const GitAccountsConfigDef = GitAccountsConfigFile as ConfigDef;

/**
 * `state/git-accounts/keys.json`: the PRIVATE halves of the SSH keys Ferretry made, SEALED (0600, the vault's key), one
 * entry per account id. The only readers are the ssh-agent feeder (it writes the key to `ssh-add -` on stdin) and
 * nothing else: no route, command, port method, `use` or `${secret:}` returns or reaches it, and it is never put in
 * an environment variable or written to another file. A GPG signing key's secret half is a second entry here, named
 * `<account id>:gpg`, read only to be fed to `gpg --import` on stdin.
 */
export const GIT_ACCOUNT_KEYS = defineSealedDocument({ name: 'keys', path: 'keys.json' });
