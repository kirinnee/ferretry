/**
 * Access's wire (§2.1) beyond today's protocol files: what other plugins hand Access, and Access's own state file.
 * The route bodies are copied from today's `packages/protocol/src/lib/{pairing,push,step-up,grants}.ts` into
 * `pairing.ts`, `push.ts`, `step-up.ts` and `grants.ts` beside this file.
 *
 * THERE IS NO DEVICE TOKEN, AND NO SCHEMA FOR ONE. A paired device proves itself by signing each session's
 * transcript with a key it cannot export; the daemon holds only the public half, and no view here carries it.
 */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { ReadCapabilityGrantsSchema } from '@ferretry/core-gate/contract';
import { PairedDeviceIdSchema, PairingDeviceNameSchema } from './pairing.ts';

/** One buzz as another plugin hands it to Access (Agenda's `uses`): words only, never a secret. */
export const BuzzSchema = z.strictObject({
  tag: z.string().min(1).max(200),
  title: z.string().min(1),
  body: z.string(),
  url: z.string().min(1),
});
export type Buzz = z.infer<typeof BuzzSchema>;

// ─── state (§9.2: devices.json, passkeys.json, unlocks.json, push.json, push-keys.json) ───────────────────────────

/** `state/access/devices.json`: each device's public key and grants. The public key never crosses the wire. */
export const DevicesFileSchema = z.strictObject({
  format: z.literal(1),
  devices: z.array(
    z.strictObject({
      id: PairedDeviceIdSchema,
      name: PairingDeviceNameSchema,
      /** The device's non-extractable signing key, public half (SPKI, base64url). */
      publicKey: z.base64url().min(1).max(512),
      createdAt: InstantSchema,
      lastSeenAt: InstantSchema,
      pairedOver: z.enum(['direct', 'relay']).optional(),
      grants: ReadCapabilityGrantsSchema,
    }),
  ),
});
export type DevicesFile = z.infer<typeof DevicesFileSchema>;
