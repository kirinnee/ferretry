import { z } from 'zod';

/**
 * The sign-in window's wire shape.
 *
 * It lives here rather than in `@ferretry/protocol` only because the daemon's login routes have not
 * landed yet; move it there when they do, so both ends validate one definition.
 */
const BrowserLoginStateSchema = z.enum(['closed', 'opening', 'open', 'closing', 'error']);

const BrowserLoginConnectionSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  password: z.string().min(1),
  sshTunnel: z.string().min(1),
});

export const BrowserLoginStatusSchema = z.object({
  state: BrowserLoginStateSchema,
  /**
   * Optional on purpose. ABSENCE RENDERS AS UNKNOWN: a daemon that did not report the flag has not
   * told us the profile is unprimed, and printing "no" there would teach the operator that a signed
   * -in profile had been lost — the most dangerous lie this feature can tell.
   */
  profilePrimed: z.boolean().optional(),
  openedAt: z.string().min(1).optional(),
  expiresAt: z.string().min(1).optional(),
  connection: BrowserLoginConnectionSchema.optional(),
  error: z.string().min(1).optional(),
});
export type BrowserLoginStatus = z.infer<typeof BrowserLoginStatusSchema>;

export function renderLoginStatus(status: BrowserLoginStatus): string {
  const lines = [`browser login window: ${status.state}`];
  if (status.openedAt) lines.push(`opened ${status.openedAt}`);
  if (status.expiresAt) lines.push(`closes ${status.expiresAt}`);
  lines.push(`profile primed: ${status.profilePrimed === undefined ? 'unknown' : status.profilePrimed ? 'yes' : 'no'}`);
  if (status.connection) {
    // The daemon substitutes the real port and a one-shot password; nobody assembles this by hand.
    lines.push(`tunnel: ${status.connection.sshTunnel}`);
    lines.push(`then point a VNC viewer at ${status.connection.host}:${status.connection.port}`);
    lines.push(`password: ${status.connection.password}`);
  }
  if (status.error) lines.push(`error: ${status.error}`);
  return lines.join('\n');
}
