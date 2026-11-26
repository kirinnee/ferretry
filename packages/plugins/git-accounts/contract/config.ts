import { z } from 'zod';

/**
 * The OAuth app's public client id for the GitHub device flow. A client id is public by design; there is NO client
 * secret anywhere in Ferretry, because the device flow needs none (the owner enabled "Device Flow" on the app).
 * A fork points `config/git-accounts.yaml` `github.clientId` at its own app.
 */
export const GITHUB_DEVICE_CLIENT_ID = 'Ov23liHZjkFulWlicHXd';

/**
 * What is asked at connect time (owner's answer, !A571): the profile, the emails, the three key scopes, `repo` and
 * `read:org`. No `workflow`. One constant: changing what is asked is a one-line change here.
 */
export const GITHUB_SCOPES = [
  'read:user',
  'user:email',
  'write:public_key',
  'write:ssh_signing_key',
  'repo',
  'read:org',
] as const;

/** Revocation needs admin:gpg_key; only an explicit GPG consent asks for it. */
export const githubScopes = (signingFormat: 'ssh' | 'gpg'): readonly string[] =>
  signingFormat === 'gpg' ? [...GITHUB_SCOPES, 'admin:gpg_key'] : GITHUB_SCOPES;

/**
 * What the consent screen says about the scopes, in plain words. `repo` is the strong one and is said plainly: the
 * token can read AND write every repository the account can reach, private ones included. It stays in the sealed
 * store and is never shown or returned; ferrets use it only through the daemon.
 */
export const GITHUB_CONSENT = [
  'Ferretry will be able to read and write EVERY repository this GitHub account can reach, private ones included (the "repo" permission).',
  'It will also read your profile, your email addresses and your organizations, and manage SSH keys. Choosing GPG also permits managing GPG keys (admin:gpg_key), including removal.',
  'It will not be able to change GitHub Actions workflow files, and it never sees your password.',
  'The access token is kept sealed on this machine. No page, command or ferret can read it: the daemon uses it for GitHub on your behalf, and a ferret can only ask the daemon to run narrowed GitHub commands as this account.',
  'To end the access completely, disconnect the account here and then revoke Ferretry at github.com/settings/applications.',
] as const;

export const GitAccountsConfigSchema = z.strictObject({
  github: z
    .strictObject({
      clientId: z
        .string()
        .regex(/^[A-Za-z0-9._-]{0,64}$/u)
        .default(GITHUB_DEVICE_CLIENT_ID),
    })
    .default({ clientId: GITHUB_DEVICE_CLIENT_ID }),
});
export type GitAccountsConfig = z.infer<typeof GitAccountsConfigSchema>;

/**
 * Naming a different OAuth app asks the person to authorize something else than what they installed Ferretry for, so
 * any change of the client id is held for the owner.
 */
export function gitAccountsLoosens(before: GitAccountsConfig | undefined, after: GitAccountsConfig): readonly string[] {
  const was = before?.github.clientId ?? GITHUB_DEVICE_CLIENT_ID;
  return was === after.github.clientId
    ? []
    : ['a different GitHub OAuth app would be asked to authorize this machine’s Git accounts'];
}
