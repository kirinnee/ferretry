/**
 * The wire shapes of a connected Git account (plugin `git-accounts`).
 *
 * NOTHING HERE CAN CARRY A TOKEN. Every object is strict, and `NO_SECRET_FIELDS` names the words no field of an
 * account or a flow may use (the contract test reads every schema against it). The OAuth token lives in the
 * daemon half's sealed document and nowhere else; the device code GitHub issues is a bearer for the token too, so it
 * stays inside the daemon and only OUR flow id and the short user code cross the wire.
 */
import { z } from 'zod';

/** A closed union so GitLab can be added later without reshaping an account. */
export const GIT_PROVIDERS = ['github'] as const;
export const GitProviderSchema = z.enum(GIT_PROVIDERS);
export type GitProvider = z.infer<typeof GitProviderSchema>;

/** `gha_<GitHub's numeric user id>`: one connection per GitHub user, re-connecting replaces the token. */
export const GitAccountIdSchema = z.string().regex(/^gha_[0-9]{1,20}$/u, 'a git account id is gha_ and digits');
export type GitAccountId = z.infer<typeof GitAccountIdSchema>;

/** The public half of an SSH key, as one OpenSSH line: `ssh-ed25519 AAAA…` (a comment may follow). */
export const SshPublicKeySchema = z
  .string()
  .max(2048)
  .regex(
    /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]{0,200})?$/u,
    'one OpenSSH public key line',
  );
/** `SHA256:` and 43 base64 characters, as `ssh-keygen -l` prints it. */
export const SshFingerprintSchema = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/u);

/**
 * A key on the account at GitHub. Public facts only: the private half of a key Ferretry made lives in the sealed
 * `keys.json` and never leaves the daemon.
 */
export const GitAccountKeySchema = z.strictObject({
  /** GitHub's id of the registered key (to delete it again). Absent for a key the person already had (never deleted by us). */
  githubKeyId: z
    .string()
    .regex(/^[0-9]{1,20}$/u)
    .optional(),
  title: z.string().min(1).max(200),
  /** The public key line, for `user.signingkey` and for the screen. */
  publicKey: SshPublicKeySchema.optional(),
  fingerprint: SshFingerprintSchema.optional(),
  /** `generated`: made here, private half sealed here. `own`: the person's own key, used through the host's ssh-agent. */
  source: z.enum(['generated', 'own']).optional(),
});
export type GitAccountKey = z.infer<typeof GitAccountKeySchema>;

export const GitAccountKeysSchema = z.strictObject({
  ssh: GitAccountKeySchema.optional(),
  signing: GitAccountKeySchema.optional(),
});
export type GitAccountKeys = z.infer<typeof GitAccountKeysSchema>;

/** What the daemon remembers about an account in the clear, and what every route answers. No secret, no digest. */
export const GitAccountSchema = z.strictObject({
  id: GitAccountIdSchema,
  provider: GitProviderSchema,
  /** GitHub's numeric user id. Public (it is in the noreply address `<id>+<login>@users.noreply.github.com`). */
  githubId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  login: z.string().min(1).max(100),
  name: z.string().max(200).optional(),
  avatarUrl: z.url().max(500).optional(),
  scopes: z.array(z.string().min(1).max(64)).max(32),
  keys: GitAccountKeysSchema,
  createdAt: z.iso.datetime(),
});
export type GitAccount = z.infer<typeof GitAccountSchema>;
export const GitAccountListSchema = z.array(GitAccountSchema);

/** `state/git-accounts/accounts.json`. */
export const GitAccountsFileSchema = z.strictObject({
  format: z.literal(1),
  accounts: z.array(GitAccountSchema).max(64),
});
export type GitAccountsFile = z.infer<typeof GitAccountsFileSchema>;

// ─── the device flow ──────────────────────────────────────────────────────────────────────────────────────────────

export const GitFlowIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/u);

/** What a started flow shows the person: the code to type, where to type it, and when it stops working. */
export const GitDeviceFlowSchema = z.strictObject({
  flowId: GitFlowIdSchema,
  provider: GitProviderSchema,
  userCode: z.string().min(1).max(32),
  verificationUri: z.url().max(300),
  expiresAt: z.iso.datetime(),
  /** Seconds between polls the page may make. Polling faster is answered `pending` without asking GitHub. */
  interval: z.number().int().min(1).max(3600),
});
export type GitDeviceFlow = z.infer<typeof GitDeviceFlowSchema>;

export const GitDeviceFlowStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pending'), interval: z.number().int().min(1).max(3600) }),
  z.strictObject({ status: z.literal('slow_down'), interval: z.number().int().min(1).max(3600) }),
  z.strictObject({ status: z.literal('done'), accountId: GitAccountIdSchema, login: z.string().min(1).max(100) }),
  z.strictObject({ status: z.literal('expired') }),
  z.strictObject({ status: z.literal('denied') }),
]);
export type GitDeviceFlowStatus = z.infer<typeof GitDeviceFlowStatusSchema>;

export const GitAccountRemovedSchema = z.strictObject({
  id: GitAccountIdSchema,
  removed: z.literal(true),
  /** Registered keys that could not be taken off the account at GitHub (the person deletes them there). */
  keysLeftOnProvider: z.array(z.string().min(1).max(200)).max(8),
  /** Revoking an OAuth token needs the client secret, which Ferretry deliberately does not have. */
  revokeAt: z.url(),
});
export type GitAccountRemoved = z.infer<typeof GitAccountRemovedSchema>;

export const GIT_ACCOUNT_CODES = {
  clientIdUnset: 'client_id_unset',
  unknownFlow: 'unknown_flow',
  unknownAccount: 'unknown_account',
  tooManyFlows: 'too_many_flows',
  providerUnreachable: 'provider_unreachable',
  providerRefused: 'provider_refused',
  invalidRequest: 'invalid_request',
  keyRefused: 'key_refused',
  keyNotOnAccount: 'key_not_on_account',
  agentUnavailable: 'agent_unavailable',
  /** The daemon's scratch folder sits where `git` cannot be fenced into it (a `:` in its parent's path). */
  scratchUnusable: 'scratch_unusable',
} as const;

/** Where a person ends an OAuth app's access to their account. Shown, never opened for them. */
export const GITHUB_REVOKE_URL = 'https://github.com/settings/applications';

/** The words no field of any wire shape here may be named by. A test reads every schema against it. */
export const NO_SECRET_FIELDS = /token|secret|password|private|deviceCode|device_code|accessToken|bearer|digest/iu;

// ─── SSH keys per account (B3) ────────────────────────────────────────────────────────────────────────────────────────

/** What a key is for: `auth` (push and pull over SSH), `signing` (sign commits), or `both` (one key, two registrations). */
export const GIT_KEY_PURPOSES = ['auth', 'signing', 'both'] as const;
export const GitKeyPurposeSchema = z.enum(GIT_KEY_PURPOSES);
export type GitKeyPurpose = z.infer<typeof GitKeyPurposeSchema>;
/** The two registrations a key can hold at GitHub; `both` is a request for the two. */
export const GitKeyKindSchema = z.enum(['auth', 'signing']);
export type GitKeyKind = z.infer<typeof GitKeyKindSchema>;

/**
 * `POST /v1/git-accounts/:id/keys`. With no `publicKey` Ferretry makes an ed25519 key and registers its public half.
 * With one, the person says "I already have this key on GitHub": it is only recorded (after GitHub confirms the
 * account holds it), the private half is never asked for, and the host's own ssh-agent is used.
 */
export const GitKeyRequestSchema = z.strictObject({
  purpose: GitKeyPurposeSchema,
  publicKey: SshPublicKeySchema.optional(),
});
export type GitKeyRequest = z.infer<typeof GitKeyRequestSchema>;

/** The public half and what is registered. Never the private half. */
export const GitKeyResultSchema = z.strictObject({
  publicKey: SshPublicKeySchema,
  fingerprint: SshFingerprintSchema,
  /** The registrations this account holds for the key now. */
  registered: z.array(GitKeyKindSchema).max(2),
  source: z.enum(['generated', 'own']),
});
export type GitKeyResult = z.infer<typeof GitKeyResultSchema>;

export const GitKeyRemovedSchema = z.strictObject({
  id: GitAccountIdSchema,
  purpose: GitKeyKindSchema,
  removed: z.literal(true),
});
export type GitKeyRemoved = z.infer<typeof GitKeyRemovedSchema>;
