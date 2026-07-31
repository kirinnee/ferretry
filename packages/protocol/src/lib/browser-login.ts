import { z } from 'zod';
import { InstantSchema } from './common.ts';

/** The daemon-global, human-operated VNC login window lifecycle. */
export const BrowserLoginStateSchema = z.enum(['closed', 'opening', 'open', 'closing', 'error']);
export type BrowserLoginState = z.infer<typeof BrowserLoginStateSchema>;

/** A TCP port number suitable for the loopback VNC endpoint. */
const TcpPortSchema = z.number().int().min(1).max(65_535);

/** Reject blank protocol fields without altering passwords or operator text. */
const NonBlankStringSchema = z.string().refine(value => value.trim() !== '', 'must not be blank');

/**
 * Short-lived connection credentials for the human login window.
 *
 * The VNC server is bound to loopback and reached through the operator's own
 * SSH tunnel, so the host is the literal `127.0.0.1` the daemon emits rather
 * than a configurable endpoint: any other host is a redirected viewer, not a
 * deployment choice. The password and the tunnel command are carried
 * byte-for-byte — they are pasted, so a trimmed or rewritten value is a wrong
 * value.
 */
export const BrowserLoginConnectionSchema = z.strictObject({
  host: z.literal('127.0.0.1'),
  port: TcpPortSchema,
  password: NonBlankStringSchema,
  sshTunnel: NonBlankStringSchema,
});
export type BrowserLoginConnection = z.infer<typeof BrowserLoginConnectionSchema>;

/** Every login status names the profile marker, in every state. */
const BrowserLoginStatusShape = { profilePrimed: z.boolean() };

/**
 * Daemon-global status for the human VNC login window. This is deliberately
 * distinct from BrowserStatusSchema, which describes per-session automation.
 *
 * The status is state-discriminated because each lifecycle field is only
 * meaningful in the states that produce it, and a flat optional shape would
 * accept combinations the daemon can never emit — a `closed` window still
 * carrying a live VNC password, or an `open` one carrying a failure message.
 * Absence has to render as absence rather than as a stale countdown, so:
 *
 *   - `connection` exists only while the window is `open`, where it is required.
 *   - `openedAt`/`expiresAt` exist only for `open` and `closing`.
 *   - `error` exists only for `error`, and is optional there because the daemon
 *     omits it when it has no coarse message to report.
 *
 * The members are strict: an unmodelled key means the reader and the daemon
 * disagree about the contract, which is worth a parse failure rather than a
 * silently dropped field.
 */
export const BrowserLoginStatusSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...BrowserLoginStatusShape, state: z.literal('closed') }),
  z.strictObject({ ...BrowserLoginStatusShape, state: z.literal('opening') }),
  z.strictObject({
    ...BrowserLoginStatusShape,
    state: z.literal('open'),
    openedAt: InstantSchema,
    expiresAt: InstantSchema,
    connection: BrowserLoginConnectionSchema,
  }),
  z.strictObject({
    ...BrowserLoginStatusShape,
    state: z.literal('closing'),
    openedAt: InstantSchema,
    expiresAt: InstantSchema,
  }),
  z.strictObject({
    ...BrowserLoginStatusShape,
    state: z.literal('error'),
    error: NonBlankStringSchema.optional(),
  }),
]);
export type BrowserLoginStatus = z.infer<typeof BrowserLoginStatusSchema>;

const BrowserLoginMinutesSchema = z.number().int().min(1).max(60);

/** Explicit human-login actions; duration is expressed only in whole minutes. */
export const BrowserLoginActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start'), minutes: BrowserLoginMinutesSchema.optional() }),
  z.strictObject({ action: z.literal('stop'), primed: z.boolean().optional() }),
  z.strictObject({ action: z.literal('confirm') }),
]);
export type BrowserLoginAction = z.infer<typeof BrowserLoginActionSchema>;
