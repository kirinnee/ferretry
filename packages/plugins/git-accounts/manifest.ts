import { FerretsPort, LaunchParts } from '@ferretry/core-ferrets/contract';
import { audit, GatePort } from '@ferretry/core-gate/contract';
import { SealedDocumentsPort } from '@ferretry/core-vault/contract';
import { definePlugin, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import { ProjectsPort } from '@ferretry/plugin-projects/contract';
import {
  GIT_ACCOUNT_AUDIT,
  GIT_ACCOUNT_AUDIT_SKIP,
  GIT_ACCOUNT_CAPS,
  GIT_ACCOUNT_GH_GUARD,
  GIT_ACCOUNT_GUARD,
  GIT_ACCOUNT_KEY_GUARD,
  GIT_ACCOUNT_KEYS,
  GIT_ACCOUNT_TOKENS,
  GIT_ACCOUNTS_WORDS,
  GitAccountsConfigDef,
  GitAccountDisconnected,
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
 * THE SSH KEY (B3). One ed25519 key per account, made in the daemon, its private half sealed in `keys.json` (also private)
 * and fed to a per-account `ssh-agent` on stdin; only the public half is registered at GitHub and returned. A ferret
 * can use the agent's socket and can never read the key (docs/secrets.md, "A Git account's SSH key").
 *
 * THE GPG KEY (G8). A signing key may be an OpenPGP one instead: sealed in the same `keys.json` under `<id>:gpg`, used only in daemon memory,
 * and reached by a ferret through a signature-only socket and public-only keyring (docs/secrets.md, "A Git account's GPG signing key").
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
  // Optional: which folder is a project, and which accounts it links (B5). Off = no ferret is given an account.
  uses: { projects: ProjectsPort, ferrets: FerretsPort },
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
      route('POST /v1/git-accounts/:id/keys', {
        minimum: 'operator',
        caller: 'person',
        capability: GIT_ACCOUNT_CAPS.configure,
        noStore: true,
        audit: audit(GIT_ACCOUNT_AUDIT.keyAdded),
        guard: GIT_ACCOUNT_KEY_GUARD,
      }),
      route('DELETE /v1/git-accounts/:id/keys/:purpose', {
        minimum: 'operator',
        caller: 'person',
        capability: GIT_ACCOUNT_CAPS.configure,
        noStore: true,
        audit: audit(GIT_ACCOUNT_AUDIT.keyRemoved),
        guard: GIT_ACCOUNT_KEY_GUARD,
      }),
      route('POST /v1/git-accounts/gh/run', {
        minimum: 'operator',
        // A ferret calls it on its own credential (that is the point); a paired device needs secrets.use. The route
        // refuses a ferret that names an account, and a folder that is not the ferret's own.
        caller: 'any',
        capability: GIT_ACCOUNT_CAPS.list,
        noStore: true,
        audit: GIT_ACCOUNT_AUDIT_SKIP.ghRun,
        guard: GIT_ACCOUNT_GH_GUARD,
      }),
    ],
    cli: [
      verb('gh', {
        summary:
          "Ferretry's gh: runs gh as the GitHub account this folder's project is linked to (the `gh` on a ferret's PATH calls it)",
        args: [{ name: 'args', help: "gh's own arguments, after `--`", variadic: true }],
        options: [
          { flag: '--account <login>', help: 'the account to use (only the owner may choose; a ferret never does)' },
        ],
      }),
      verb('gh-doctor', {
        summary: "check that `gh` in this terminal is Ferretry's shim and that no GitHub token is set",
        args: [],
        options: [],
      }),
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

  ui: {
    settings: [settingsTab('accounts', { icon: 'key-round', group: 'sites', label: 'GitHub accounts', order: 43 })],
  },
  // A launch inside a project linked to an account gets that account's agent and git settings (B4).
  hooks: { takes: [{ hook: LaunchParts }] },

  /** Never reached by a ferret, through any root: the sealed OAuth tokens. */
  privacy: { private: ['tokens.json', 'keys.json'] },
  data: {
    state: [GitAccountsState, GIT_ACCOUNT_TOKENS.state, GIT_ACCOUNT_KEYS.state],
    config: [GitAccountsConfigDef],
    readModels: ['list'],
    publishes: [GitAccountDisconnected],
  },

  permissions: {
    // `downloads`: agents' stable sockets and known_hosts. `agent-homes`: exact managed shim/config directory scopes.
    roots: ['downloads', 'agent-homes'],
    setMode: true,
    // `gh` runs as an account, with its token in that child's environment alone (`GitAccountsApi.run`).
    // `ps` lists the processes once at boot, so an agent an earlier unclean run left behind can be ended (`sweep.ts`).
    spawn: ['gh', 'ssh-agent', 'ssh-add', 'ps', 'gpg', 'curl'],
    // Which `gh` gets a token (B10 SEC): the daemon's PATH minus any folder in the state home, resolved by the kernel, and an answer
    // inside the state home is refused. Nothing is executed to find out, and no PATH value is ever returned to a caller.
    hostFacts: true,
    which: true,
    checkDirectory: true,
    // `fy gh-doctor`: where this pane's `gh` is and whether a GitHub token sits in it. Names only are read; no value is ever printed.
    cliEnvReads: ['PATH', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN'],
    // The device flow and the profile read (github.com), the profile and key calls (api.github.com): nowhere else.
    network: ['github.com', 'api.github.com'],
  },
});
