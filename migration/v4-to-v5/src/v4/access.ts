/**
 * v4 Access files (4.291.5). A LOCAL copy on purpose: the product has no v4 reader. Field for field from today's
 * adapters (`docs/migration/v4-formats.md` §1 rows `devices.json` … `grant-audit.jsonl`):
 *
 * - `state/devices.json` (`adapters/pairing/state-pairing-repository.ts:72-84`): `{schemaVersion: 2, daemonId, devices}`;
 *   a `schemaVersion: 1` document is the bearer era, which v4 itself dropped (every device paired again).
 * - `state/passkeys.json` (`adapters/step-up/state-passkey-store.ts:35-44`): `{schemaVersion: 1, passkeys}`, WebAuthn
 *   public keys and sign counters, one row per credential, keyed to a paired device id.
 * - `state/unlocks.json` (`adapters/step-up/state-unlock-ledger.ts:30-35`): the last passkey unlock per device. Not
 *   read by this tool: live unlocks are not carried.
 * - `state/push.json` (`adapters/push/state-push-repository.ts:63-79`): `{schemaVersion: 1, subscriptions}`; the
 *   legacy per-record `prefs` is tolerated and dropped, as v4 dropped it on its next write.
 * - `state/push-vapid.json` (`adapters/push/webcrypto-vapid-keys.ts:41-43,145`): `{schemaVersion: 1, privateKeyJwk}`,
 *   the VAPID private key. SECRET.
 * - `state/grant-audit.jsonl`, `state/security-audit.jsonl` (`adapters/grants/runtime-grant-ports.ts:72-100`,
 *   `JournalGrantAudit`, never rotated): `{kind, at, actor, changes}`; v4's `readAuditLine` counted a line it could
 *   not read and never showed it. `kind` is `grant.changed` / `security.changed` (and `device.key-rotated` in the
 *   security journal, `bin/fyd.ts:8628`); `actor` a string — `admin-cli`, `admin-ui`, `device:<id>`, `device`,
 *   `warden[:<sid>]` or `peer:<sid>` (`lib/api/actor.ts`); `changes` `capability.axis=on|off` / `setting=value`.
 */
import { z } from 'zod';

export const V4_DEVICES = 'state/devices.json';
export const V4_PASSKEYS = 'state/passkeys.json';
export const V4_UNLOCKS = 'state/unlocks.json';
export const V4_PUSH = 'state/push.json';
export const V4_PUSH_VAPID = 'state/push-vapid.json';
export const V4_GRANT_JOURNAL = 'state/grant-audit.jsonl';
export const V4_SECURITY_JOURNAL = 'state/security-audit.jsonl';

/** `state-pairing-repository.ts:72-82`. Grants are an open record here: which names v5 keeps is the step's call. */
export const V4GrantSchema = z.strictObject({ use: z.boolean(), configure: z.boolean() });
export type V4Grant = z.infer<typeof V4GrantSchema>;
export const V4DeviceSchema = z.strictObject({
  id: z.string(),
  daemonId: z.string(),
  name: z.string(),
  platform: z.literal('browser'),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  pairedOver: z.enum(['direct', 'relay']).optional(),
  publicKey: z.string(),
  grants: z.record(z.string(), V4GrantSchema),
  keyRotatedAt: z.string().optional(),
});
export const V4DevicesSchema = z.strictObject({
  schemaVersion: z.literal(2),
  daemonId: z.string(),
  devices: z.array(V4DeviceSchema),
});

/** `state-passkey-store.ts:26-36`, with v4's own bounds left to the v5 schema that re-checks every row. */
export const V4PasskeySchema = z.strictObject({
  credentialId: z.string(),
  deviceId: z.string(),
  algorithm: z.number(),
  publicKeySpki: z.string(),
  signCount: z.number(),
  origin: z.string(),
  createdAt: z.string(),
});
export const V4PasskeysSchema = z.strictObject({ schemaVersion: z.literal(1), passkeys: z.array(V4PasskeySchema) });

/** `state-push-repository.ts:63-79`. The subscription is re-checked whole by v5's `BrowserPushSubscriptionSchema`. */
export const V4PushRecordSchema = z.strictObject({
  id: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
  subscription: z.unknown(),
  createdAt: z.string(),
  updatedAt: z.string(),
  prefs: z.unknown().optional(),
});
export const V4PushSchema = z.strictObject({ schemaVersion: z.literal(1), subscriptions: z.array(V4PushRecordSchema) });

/** v4's `readAuditLine`: a journal line, or a failure when it is not a record v4 would have read. */
export const V4JournalLine = z.object({
  kind: z.string().min(1),
  at: z.string().min(1),
  actor: z.string().min(1),
  changes: z.array(z.string()),
});
export type V4JournalLine = z.infer<typeof V4JournalLine>;
