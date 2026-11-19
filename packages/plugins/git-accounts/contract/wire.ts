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

/** A key this machine registered on the account at GitHub. Public facts only (B3 fills these). */
export const GitAccountKeySchema = z.strictObject({
  /** GitHub's id of the registered key (to delete it again). */
  githubKeyId: z.string().regex(/^[0-9]{1,20}$/u),
  title: z.string().min(1).max(200),
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
} as const;

/** Where a person ends an OAuth app's access to their account. Shown, never opened for them. */
export const GITHUB_REVOKE_URL = 'https://github.com/settings/applications';

/** The words no field of any wire shape here may be named by. A test reads every schema against it. */
export const NO_SECRET_FIELDS = /token|secret|password|private|deviceCode|device_code|accessToken|bearer|digest/iu;
