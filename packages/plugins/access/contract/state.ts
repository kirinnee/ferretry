/**
 * Access's state files (§9.2), each a kernel `defineState` at `format: 1`. The record schemas are today's adapters'
 * (`daemon/src/adapters/{pairing,step-up,push,grants}/…`), copied field for field; every reader of an older shape is
 * gone (the bearer-token `devices.json`, the missing-`grants` default, the missing-capability fill, push `prefs`).
 * The kernel parses each file against its schema and reports a mismatch as damaged; no route returns a key.
 */
import { defineState } from '@ferretry/kernel/contract';
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { CapabilityGrantsSchema } from '@ferretry/core-gate/contract';
import { DaemonIdSchema, PairedDeviceIdSchema, PairingDeviceNameSchema } from './pairing.ts';
import { AppOriginSchema } from './step-up.ts';
import { BrowserPushSubscriptionSchema, PushDeviceViewSchema, RegisterPushDeviceRequestSchema } from './push.ts';

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/u);

// ─── devices.json ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One device grant. The public key is the ONLY thing kept about the device: SPKI, base64url, Ed25519 (the daemon half
 * checks the key shape when it writes). `grants` is required and closed: a malformed one fails the document closed
 * (G141's kept half); a missing one is not filled in.
 */
export const DeviceRecordSchema = z.strictObject({
  id: PairedDeviceIdSchema,
  daemonId: DaemonIdSchema,
  name: PairingDeviceNameSchema,
  platform: z.literal('browser'),
  createdAt: InstantSchema,
  lastSeenAt: InstantSchema,
  pairedOver: z.enum(['direct', 'relay']).optional(),
  /** The device's non-extractable signing key, public half (SPKI, base64url). Never on the wire. */
  publicKey: Base64Url.min(1).max(512),
  grants: CapabilityGrantsSchema,
  /** When `publicKey` last replaced an earlier one. Absent until a first rotation. */
  keyRotatedAt: InstantSchema.optional(),
});
export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

/** `state/access/devices.json`: the device grants of ONE daemon identity. */
export const DevicesFileSchema = z.strictObject({
  format: z.literal(1),
  daemonId: DaemonIdSchema,
  devices: z.array(DeviceRecordSchema),
});
export type DevicesFile = z.infer<typeof DevicesFileSchema>;

export const DevicesFile = defineState({
  name: 'devices',
  path: 'devices.json',
  store: 'json',
  format: 1,
  schema: DevicesFileSchema,
  mode: 0o600,
});

// ─── passkeys.json ────────────────────────────────────────────────────────────────────────────────────────────────

export const StoredPasskeySchema = z.strictObject({
  credentialId: Base64Url.max(1_366),
  deviceId: PairedDeviceIdSchema,
  algorithm: z.union([z.literal(-7), z.literal(-8), z.literal(-257)]),
  publicKeySpki: Base64Url.max(2_048),
  signCount: z.number().int().min(0).max(0xffff_ffff),
  origin: AppOriginSchema,
  createdAt: InstantSchema,
});

export const PasskeysFileSchema = z.strictObject({ format: z.literal(1), passkeys: z.array(StoredPasskeySchema) });
export type PasskeysFile = z.infer<typeof PasskeysFileSchema>;

export const PasskeysFile = defineState({
  name: 'passkeys',
  path: 'passkeys.json',
  store: 'json',
  format: 1,
  schema: PasskeysFileSchema,
  mode: 0o600,
});

// ─── unlocks.json ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Device id and instant only: no key, token or signature (G76). Bound to the daemon identity that wrote it. */
export const UnlocksFileSchema = z.strictObject({
  format: z.literal(1),
  daemonId: z.string().min(1).max(200),
  unlocks: z.array(z.strictObject({ deviceId: PairedDeviceIdSchema, unlockedAt: InstantSchema })).max(10_000),
});
export type UnlocksFile = z.infer<typeof UnlocksFileSchema>;

export const UnlocksFile = defineState({
  name: 'unlocks',
  path: 'unlocks.json',
  store: 'json',
  format: 1,
  schema: UnlocksFileSchema,
  mode: 0o600,
});

// ─── push.json, push-keys.json ────────────────────────────────────────────────────────────────────────────────────

export const PushRecordSchema = z.strictObject({
  id: PushDeviceViewSchema.shape.id,
  deviceId: PairedDeviceIdSchema,
  deviceName: RegisterPushDeviceRequestSchema.shape.deviceName,
  subscription: BrowserPushSubscriptionSchema,
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
});

export const PushFileSchema = z.strictObject({ format: z.literal(1), subscriptions: z.array(PushRecordSchema) });
export type PushFile = z.infer<typeof PushFileSchema>;

export const PushFile = defineState({
  name: 'push',
  path: 'push.json',
  store: 'json',
  format: 1,
  schema: PushFileSchema,
  mode: 0o600,
});

const JsonWebKeySchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  d: z.string().min(1),
  x: z.string().min(1),
  y: z.string().min(1),
});

/** The VAPID signing key; the private half never leaves this file and no route returns it. */
export const PushKeysFileSchema = z.strictObject({ format: z.literal(1), privateKeyJwk: JsonWebKeySchema });
export type PushKeysFile = z.infer<typeof PushKeysFileSchema>;

export const PushKeysFile = defineState({
  name: 'push-keys',
  path: 'push-keys.json',
  store: 'secret',
  format: 1,
  schema: z.instanceof(Uint8Array),
  mode: 0o600,
});

// ─── grant-audit.jsonl ────────────────────────────────────────────────────────────────────────────────────────────

/** One device-grant or security change, attributed to its actor, never a credential (G150, P122). */
export const GrantAuditLineSchema = z.strictObject({
  format: z.literal(1),
  kind: z.string().min(1).max(64),
  at: InstantSchema,
  actor: z.string().min(1),
  changes: z.array(z.string()),
});
export type GrantAuditLine = z.infer<typeof GrantAuditLineSchema>;

export const GrantAuditFile = defineState({
  name: 'grant-audit',
  path: 'grant-audit.jsonl',
  store: 'jsonl',
  format: 1,
  schema: GrantAuditLineSchema,
  mode: 0o600,
});

/** Private, short-lived redirect pages shared by fy pair --open and the daemon's boot sweep (P106). */
export const PairingRedirectsFile = defineState({
  name: 'pairing-redirects',
  path: 'pairing-redirects/*',
  store: 'opaque',
  format: 1,
  schema: z.instanceof(Uint8Array),
  mode: 0o600,
});
