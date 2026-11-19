import { audit, GatePort } from '@ferretry/core-gate/contract';
import { SealedDocumentsPort } from '@ferretry/core-vault/contract';
import { definePlugin, route, verb } from '@ferretry/kernel/manifest';
import {
  GIT_ACCOUNT_AUDIT,
  GIT_ACCOUNT_AUDIT_SKIP,
  GIT_ACCOUNT_CAPS,
  GIT_ACCOUNT_GUARD,
  GIT_ACCOUNT_TOKENS,
  GIT_ACCOUNTS_WORDS,
  GitAccountsConfigDef,
  GitAccountsPort,
  GitAccountsState,
} from './contract/index.ts';

/**
 * Git accounts (r9 B1): GitHub accounts connected to this machine by the OAuth device flow. No client secret exists.
 *
 * THE TOKEN. It is sealed in this plugin's own document (`state/git-accounts/tokens.json`), NOT in the shared secret
 * list, because every agent can `fy secret use` a shared secret and a GitHub token is too strong for that. Only the
 * daemon half opens it, to place it on a request to `api.github.com`. No route, command, port method, `use` or
 * `${secret:}` returns or reaches it. The plugin is called `git-accounts` because `connections` is the network carrier.
 *
 * Capabilities: no new one. Connect and remove are `secrets.configure` (passkey step-up from a paired device); the
 * list is `secrets.use`.
 */
export default definePlugin({
  id: 'git-accounts',
  title: 'Git accounts',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command'],
  words: GIT_ACCOUNTS_WORDS,

  needs: { sealed: SealedDocumentsPort, gate: GatePort },
  provides: { gitAccounts: GitAccountsPort },

  actions: {
    routes: [
      route('POST /v1/git-accounts/github/device', {
        minimum: 'operator',
        caller: 'person',
        capability: GIT_ACCOUNT_CAPS.configure,
        noStore: true,
        audit: GIT_ACCOUNT_AUDIT_SKIP.startFlow,
        guard: GIT_ACCOUNT_GUARD,
      }),
      route('GET /v1/git-accounts/github/device/:flowId', {
        minimum: 'operator',
        caller: 'person',
        capability: GIT_ACCOUNT_CAPS.configure,
        noStore: true,
        // A poll is not an act. The connect is recorded once, by the service, with the account id (not the flow id).
        audit: GIT_ACCOUNT_AUDIT_SKIP.pollFlow,
        guard: GIT_ACCOUNT_GUARD,
      }),
      route('GET /v1/git-accounts', {
        minimum: 'operator',
        caller: 'any',
        capability: GIT_ACCOUNT_CAPS.list,
        noStore: true,
        audit: GIT_ACCOUNT_AUDIT_SKIP.list,
        guard: GIT_ACCOUNT_GUARD,
      }),
      route('DELETE /v1/git-accounts/:id', {
        minimum: 'operator',
        caller: 'person',
        capability: GIT_ACCOUNT_CAPS.configure,
        noStore: true,
        audit: audit(GIT_ACCOUNT_AUDIT.removed),
        guard: GIT_ACCOUNT_GUARD,
      }),
    ],
    cli: [
      verb('git account add', {
        summary: 'connect a GitHub account: shows a code to type on GitHub, then waits',
        args: [],
        options: [{ flag: '--json', help: 'print the code and the result as JSON' }],
      }),
      verb('git account ls', {
        summary: 'list the Git accounts connected to this machine (never a token)',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('git account rm', {
        summary: 'disconnect a Git account: deletes the keys Ferretry registered on it, then forgets its token',
        args: [{ name: 'account', help: 'the account id (gha_…) or its GitHub name' }],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
    ],
  },

  /** Never reached by a ferret, through any root: the sealed OAuth tokens. */
  privacy: { private: ['tokens.json'] },
  data: {
    state: [GitAccountsState, GIT_ACCOUNT_TOKENS.state],
    config: [GitAccountsConfigDef],
    readModels: ['list'],
  },

  permissions: {
    roots: [],
    // `gh` runs as an account, with its token in that child's environment alone (`GitAccountsApi.run`).
    spawn: ['gh'],
    // The device flow and the profile read (github.com), the profile and key calls (api.github.com): nowhere else.
    network: ['github.com', 'api.github.com'],
  },
});
