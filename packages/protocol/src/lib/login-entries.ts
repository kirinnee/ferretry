import { z } from 'zod';
import { InstantSchema } from './common.ts';
import { MIN_SECRET_VALUE_LENGTH, SecretNameSchema, SecretStoreHealthSchema } from './secrets.ts';

/**
 * SAVED LOGINS: the password manager the input bridge places values from (docs/input-requests.md, "Saved
 * logins").
 *
 * A saved login is a LABELLED ENTRY, the way a password manager keeps one: a label the owner reads
 * ("GitHub (kirinnee)"), what it is for (`match`: `sudo@kirin-box`, `github.com`), and its fields:
 *
 * - `username`: PLAIN. Stored as text, shown on the card, and allowed to reach the ferret, because a
 *   username is typed where the ferret can see it anyway.
 * - `password`: SECRET. Sealed in the daemon's vault; no route, command or API returns it.
 * - `totp`: SECRET, OPT-IN. A 2FA seed, sealed the same way. The daemon makes the current code inside the
 *   use boundary and types it as a `private` value; neither the seed nor the code is ever returned.
 *
 * ## THE SAME RULE AS EVERY OTHER SECRET: USE, NEVER READ
 *
 * A value travels IN, on {@link PutLoginEntryRequestSchema}, and never travels back. Everything a client
 * may learn about an entry is {@link LoginEntrySummarySchema}: the label, what it matches, the username,
 * WHICH secret fields exist, and when it changed. No value, no length, no digest. A saved value leaves the
 * daemon only into the target of an input request the owner tapped "Use" on.
 */

/** An entry's handle: the shape of a secret name, because the CLI and the card name it (`SUDO_KIRIN_BOX`). */
export const LoginEntryIdSchema = SecretNameSchema;
export type LoginEntryId = z.infer<typeof LoginEntryIdSchema>;

export const LOGIN_LABEL_MAX_LENGTH = 80;
export const LOGIN_USERNAME_MAX_LENGTH = 256;
export const LOGIN_MATCH_MAX = 16;
/** Most entries one daemon keeps: a list a person can read, not a database. */
export const MAX_LOGIN_ENTRIES = 256;
/**
 * The shortest password an entry keeps. A REDACTION constraint, exactly as {@link MIN_SECRET_VALUE_LENGTH}
 * is: a saved value is masked wherever the daemon scrubs text, and a very short value would mask ordinary
 * words. A shorter password can still be TYPED on a card; it just cannot be saved.
 */
export const LOGIN_PASSWORD_MIN_LENGTH = MIN_SECRET_VALUE_LENGTH;
export const LOGIN_PASSWORD_MAX_LENGTH = 1_024;

const oneLine = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'must be one line with no control characters');

/**
 * What an entry is for, as the daemon names a target: `program@host` for a terminal (`sudo@kirin-box`,
 * `ssh@build.example.com`), or a web host for a page (`github.com`, `localhost:8443`). Lowercase. The DAEMON
 * works out a target's key from what it observed; an agent never says what matches.
 */
export const LoginMatchSchema = z
  .string()
  .max(320)
  .regex(
    /^(?:[a-z0-9][a-z0-9._+-]{0,63}@)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/u,
    'a program@host or a web host, lowercase',
  );
export type LoginMatch = z.infer<typeof LoginMatchSchema>;

/** The fields an entry can hold, and which of them are secret. */
export const LOGIN_FIELD_ROLES = ['username', 'password', 'totp'] as const;
export const LoginFieldRoleSchema = z.enum(LOGIN_FIELD_ROLES);
export type LoginFieldRole = z.infer<typeof LoginFieldRoleSchema>;

/** How the code is made from the seed (RFC 6238). Not secret: an authenticator shows these. */
export const TotpParametersSchema = z.strictObject({
  algorithm: z.enum(['SHA1', 'SHA256', 'SHA512']).default('SHA1'),
  digits: z.union([z.literal(6), z.literal(7), z.literal(8)]).default(6),
  period: z.number().int().min(15).max(120).default(30),
});
export type TotpParameters = z.infer<typeof TotpParametersSchema>;

/**
 * THE SENTENCE the owner reads before a 2FA seed is kept, in the app, the CLI and the docs. It is the
 * reason TOTP is off by default and opted into per entry.
 */
export const LOGIN_TOTP_WARNING =
  "Keeping the password and the 2FA seed in the same place means one compromise of this machine's vault defeats both factors.";

/** A base32 TOTP seed, as authenticator setup pages show it (spaces and `=` padding allowed). */
export const TotpSeedSchema = z
  .string()
  .transform(seed => seed.replaceAll(/[\s=-]/gu, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z2-7]{16,128}$/u, 'a base32 2FA seed of 16 to 128 characters'));

/**
 * Everything a client may learn about a saved login. `username` is plain and may be shown; `fields` says
 * which secret fields exist, never what they hold.
 */
export const LoginEntrySummarySchema = z.strictObject({
  id: LoginEntryIdSchema,
  label: oneLine(LOGIN_LABEL_MAX_LENGTH),
  match: z.array(LoginMatchSchema).max(LOGIN_MATCH_MAX).readonly(),
  username: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional(),
  fields: z.strictObject({ password: z.boolean(), totp: z.boolean() }),
  /** How the code is made, present exactly when `fields.totp`. */
  totp: TotpParametersSchema.optional(),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
});
export type LoginEntrySummary = z.infer<typeof LoginEntrySummarySchema>;

/** `GET /v1/secrets/logins`. A damaged store says so; it is never an empty list. */
export const LoginEntryListSchema = z.strictObject({
  v: z.literal(1),
  health: SecretStoreHealthSchema,
  diagnosis: z.string().min(1).optional(),
  entries: z.array(LoginEntrySummarySchema).max(MAX_LOGIN_ENTRIES).readonly(),
});
export type LoginEntryList = z.infer<typeof LoginEntryListSchema>;

/**
 * `PUT /v1/secrets/logins/:id`: create the entry, or change the parts named. A field left out is kept;
 * `null` removes it. Values travel IN only. Adding a seed needs `totpAcknowledged: true`, which the
 * client sends only after showing {@link LOGIN_TOTP_WARNING}.
 */
export const PutLoginEntryRequestSchema = z
  .strictObject({
    label: oneLine(LOGIN_LABEL_MAX_LENGTH).optional(),
    match: z.array(LoginMatchSchema).max(LOGIN_MATCH_MAX).optional(),
    username: oneLine(LOGIN_USERNAME_MAX_LENGTH).nullable().optional(),
    password: z
      .string()
      .min(LOGIN_PASSWORD_MIN_LENGTH)
      .max(LOGIN_PASSWORD_MAX_LENGTH)
      .regex(/^[^\p{Cc}]*$/u, 'a password with a control character or line break would press keys')
      .nullable()
      .optional(),
    totp: z
      .strictObject({ seed: TotpSeedSchema, parameters: TotpParametersSchema.optional() })
      .nullable()
      .optional(),
    totpAcknowledged: z.literal(true).optional(),
  })
  .superRefine((body, context) => {
    if (body.totp !== undefined && body.totp !== null && body.totpAcknowledged !== true)
      context.addIssue({
        code: 'custom',
        path: ['totpAcknowledged'],
        message: `confirm the warning first: ${LOGIN_TOTP_WARNING}`,
      });
  });
export type PutLoginEntryRequest = z.input<typeof PutLoginEntryRequestSchema>;
export type PutLoginEntry = z.output<typeof PutLoginEntryRequestSchema>;

/** `POST /v1/secrets/logins/:id/rename`. The values follow; nothing is re-typed. */
export const RenameLoginEntryRequestSchema = z.strictObject({ to: LoginEntryIdSchema });
export type RenameLoginEntryRequest = z.infer<typeof RenameLoginEntryRequestSchema>;

/** `DELETE /v1/secrets/logins/:id`. A 404 is how "there was none" is reported. */
export const RemovedLoginEntrySchema = z.strictObject({ id: LoginEntryIdSchema, removed: z.literal(true) });
export type RemovedLoginEntry = z.infer<typeof RemovedLoginEntrySchema>;

/**
 * One saved login an input card may offer. `fills` is the field it would type (the password for a
 * `secret`, the code for a `private`, the username for a `plain`). `matched` is the DAEMON's decision that
 * the entry is for this target: only a matched entry is the card's one-tap primary; the rest stay
 * selectable by hand. `hinted` says the ferret named it, which never makes it matched.
 */
export const InputSavedOfferSchema = z.strictObject({
  id: LoginEntryIdSchema,
  label: oneLine(LOGIN_LABEL_MAX_LENGTH),
  username: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional(),
  fills: LoginFieldRoleSchema,
  matched: z.boolean(),
  hinted: z.boolean().optional(),
});
export type InputSavedOffer = z.infer<typeof InputSavedOfferSchema>;

/**
 * What an input card knows about saved logins, as the owner reads it (never the agent): the target's key
 * the daemon worked out, the entry "Save as" would suggest, and the entries that can fill the field,
 * matched first.
 */
export const InputSavedSchema = z.strictObject({
  match: LoginMatchSchema.optional(),
  suggest: z.strictObject({ id: LoginEntryIdSchema, label: oneLine(LOGIN_LABEL_MAX_LENGTH) }).optional(),
  /** Which field a typed value would be saved as; absent when this kind of value is never saved (a code). */
  saves: LoginFieldRoleSchema.optional(),
  offers: z.array(InputSavedOfferSchema).max(MAX_LOGIN_ENTRIES).readonly(),
});
export type InputSaved = z.infer<typeof InputSavedSchema>;

/** The role a request's one field takes from an entry, by the request's sensitivity. */
export function fillRoleFor(sensitivity: 'secret' | 'private' | 'plain'): LoginFieldRole {
  return sensitivity === 'secret' ? 'password' : sensitivity === 'private' ? 'totp' : 'username';
}

/**
 * The handle "Save as" suggests for a target key: `sudo@kirin-box` → `SUDO_KIRIN_BOX`, `github.com` →
 * `GITHUB_COM`. Always a valid {@link LoginEntryIdSchema}; the owner can edit it.
 */
export function suggestedLoginId(match: string): LoginEntryId {
  const words = match
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '');
  const head = /^[A-Z]/u.test(words) ? words : `LOGIN_${words}`;
  return head.slice(0, 64).replace(/_+$/u, '');
}

/** The label "Save as" suggests: `sudo on kirin-box`, or the web host itself. */
export function suggestedLoginLabel(match: string): string {
  const at = match.indexOf('@');
  return (at === -1 ? match : `${match.slice(0, at)} on ${match.slice(at + 1)}`).slice(0, LOGIN_LABEL_MAX_LENGTH);
}
