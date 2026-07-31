import { z } from 'zod';
import { InstantSchema } from './common.ts';

/** The daemon-global, human-operated VNC login window lifecycle. */
export const BrowserLoginStateSchema = z.enum(['closed', 'opening', 'open', 'closing', 'error']);
export type BrowserLoginState = z.infer<typeof BrowserLoginStateSchema>;

/** A TCP port number suitable for the loopback VNC endpoint. */
const TcpPortSchema = z.number().int().min(1).max(65_535);

/** Reject blank protocol fields without altering passwords or operator text. */
const NonBlankStringSchema = z.string().refine(value => value.trim() !== '', 'must not be blank');

/** Short-lived connection credentials for the human login window. */
export const BrowserLoginConnectionSchema = z.object({
  host: NonBlankStringSchema,
  port: TcpPortSchema,
  password: NonBlankStringSchema,
  sshTunnel: NonBlankStringSchema,
});
export type BrowserLoginConnection = z.infer<typeof BrowserLoginConnectionSchema>;

/**
 * Daemon-global status for the human VNC login window. This is deliberately
 * distinct from BrowserStatusSchema, which describes per-session automation.
 */
export const BrowserLoginStatusSchema = z.object({
  state: BrowserLoginStateSchema,
  profilePrimed: z.boolean(),
  openedAt: InstantSchema.optional(),
  expiresAt: InstantSchema.optional(),
  connection: BrowserLoginConnectionSchema.optional(),
  error: NonBlankStringSchema.optional(),
});
export type BrowserLoginStatus = z.infer<typeof BrowserLoginStatusSchema>;

const BrowserLoginMinutesSchema = z.number().int().min(1).max(60);

/** Explicit human-login actions; duration is expressed only in whole minutes. */
export const BrowserLoginActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start'), minutes: BrowserLoginMinutesSchema.optional() }),
  z.strictObject({ action: z.literal('stop'), primed: z.boolean().optional() }),
  z.strictObject({ action: z.literal('confirm') }),
]);
export type BrowserLoginAction = z.infer<typeof BrowserLoginActionSchema>;
