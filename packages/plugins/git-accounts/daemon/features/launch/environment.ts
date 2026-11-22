/**
 * What a ferret in a project linked to a Git account is handed so `git push` and a signed commit work as that account
 * (r9 B4): the account's ssh-agent socket and git's own settings, as `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` /
 * `GIT_CONFIG_VALUE_n`. Plain words and paths only. The private key is not here and cannot be got from here: the socket
 * can be asked to sign and to authenticate, never to hand the key over.
 */
import type { GitAccount } from '../../../contract/index.ts';

/** What an account's agent and files are called, from the key service. Paths only. */
export interface AccountKit {
  readonly socket: string;
  /** A file holding the account's PUBLIC key. */
  readonly publicKeyFile: string;
  /** The pinned `known_hosts`. */
  readonly knownHosts: string;
  /** The key is registered at GitHub for pushing. */
  readonly auth: boolean;
  /** The key is registered at GitHub as a signing key. */
  readonly signing: boolean;
}

const SAFE = /^[A-Za-z0-9_./@:+,=-]+$/u;
/** A path as one shell word: bare when it is plain, else single-quoted (git runs `core.sshCommand` through a shell). */
const word = (text: string): string => (SAFE.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);
const clean = (text: string): string => text.replace(/[\p{Cc}]/gu, ' ').trim();

/**
 * `ssh -F none` ignores the host's `~/.ssh/config` (no ProxyCommand, ForwardAgent, alias or IdentityFile of the person's);
 * `IdentitiesOnly=yes` with this one `IdentityFile` offers exactly this account's key, taken from `IdentityAgent`; the
 * host key is checked against the pinned file alone (`GlobalKnownHostsFile=none`: the machine's own
 * `ssh_known_hosts` is not consulted), never trusted on first use.
 */
export const sshCommand = (kit: AccountKit): string =>
  [
    'ssh -F none',
    '-o IdentitiesOnly=yes',
    `-o IdentityFile=${word(kit.publicKeyFile)}`,
    `-o IdentityAgent=${word(kit.socket)}`,
    '-o StrictHostKeyChecking=yes',
    `-o UserKnownHostsFile=${word(kit.knownHosts)}`,
    '-o GlobalKnownHostsFile=none',
  ].join(' ');

/** GitHub counts `<id>+<login>@users.noreply.github.com` as a verified address of the account. */
export const noreplyEmail = (account: GitAccount): string =>
  `${String(account.githubId)}+${account.login}@users.noreply.github.com`;

/** ssh offering no identity at all: no agent, no default key file, no password. */
const NO_IDENTITY_SSH =
  'ssh -F none -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o IdentityAgent=none -o PasswordAuthentication=no';

/**
 * EVERY git-config(1) key that makes git sign by default (checked against git 2.55: the four keys whose text says
 * signing): commits, tags, annotated tags (`git tag -m`) and pushes. `user.signingkey`, `gpg.*`, `log.showSignature`
 * and `merge.verifySignatures` select a key or verify, and do not make git sign, so they are not here.
 */
const SIGNING_SWITCHES: readonly string[] = ['commit.gpgsign', 'tag.gpgsign', 'tag.forceSignAnnotated', 'push.gpgSign'];

/**
 * What a launch is given when the account has a key Ferretry made that is RECORDED but cannot be served: git is told to
 * offer no identity at all (no agent, no default key file, no password) instead of the machine's own, and not to sign
 * with a key that is not the account's. A push then fails where it would otherwise have succeeded as somebody else.
 *
 * Any generated key (a push key OR a signing-only one) closes ssh, because the account is Ferretry's to speak for; a
 * slot holding the person's OWN key is theirs and is never blocked here. Git reads `GIT_SSH_COMMAND` before
 * `core.sshCommand` before `GIT_SSH`, and a login's environment may set either variable, so the command is set in BOTH
 * places: this part is merged after the login (core ferrets), so `GIT_SSH_COMMAND` here is what git runs. Signing is
 * switched off twice too: as settings, and as the END of `GIT_CONFIG_PARAMETERS` (git applies it last, so a login's own
 * parameters cannot keep signing on).
 */
export function noIdentityEnvironment(account: GitAccount): Readonly<Record<string, string>> {
  const { ssh, signing } = account.keys;
  const generated = ssh?.source === 'generated' || signing?.source === 'generated';
  if (!generated) return {};
  const settings: [string, string][] = [];
  const env: Record<string, string> = {};
  if (ssh?.source !== 'own') {
    settings.push(['core.sshCommand', NO_IDENTITY_SSH], ['url.git@github.com:.insteadOf', 'https://github.com/']);
    env['GIT_SSH_COMMAND'] = NO_IDENTITY_SSH;
  }
  if (signing?.source !== 'own') {
    for (const key of SIGNING_SWITCHES) settings.push([key, 'false']);
    // Git applies GIT_CONFIG_PARAMETERS AFTER GIT_CONFIG_COUNT, and a login may set it to keep signing on. Core ferrets
    // appends this value to the login's, so these entries come last, in git's own quoted `'key'='value'` form, and win.
    env['GIT_CONFIG_PARAMETERS'] = SIGNING_SWITCHES.map(key => `'${key}'='false'`).join(' ');
  }
  env['GIT_CONFIG_COUNT'] = String(settings.length);
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${String(index)}`] = key;
    env[`GIT_CONFIG_VALUE_${String(index)}`] = value;
  });
  return env;
}

export function gitEnvironment(account: GitAccount, kit: AccountKit): Readonly<Record<string, string>> {
  const settings: [string, string][] = [
    ['user.name', clean(account.name ?? '') || account.login],
    ['user.email', noreplyEmail(account)],
  ];
  if (kit.signing)
    settings.push(
      ['gpg.format', 'ssh'],
      ['user.signingkey', kit.publicKeyFile],
      ['commit.gpgsign', 'true'],
      ['tag.gpgsign', 'true'],
    );
  if (kit.auth)
    settings.push(['core.sshCommand', sshCommand(kit)], ['url.git@github.com:.insteadOf', 'https://github.com/']);
  const env: Record<string, string> = { SSH_AUTH_SOCK: kit.socket, GIT_CONFIG_COUNT: String(settings.length) };
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${String(index)}`] = key;
    env[`GIT_CONFIG_VALUE_${String(index)}`] = value;
  });
  return env;
}
