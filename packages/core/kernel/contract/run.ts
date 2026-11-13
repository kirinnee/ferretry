import { z } from 'zod';

/**
 * Where the kernel records its local listener for `fy` (lead decision 7; `daemon.json` is gone in v5). Written by the
 * daemon on listen, read by `fy`; both use {@link recordedBindAddress}, so they cannot disagree (P89).
 */
export const DAEMON_RUN_FILE = 'run/daemon.json';
/** The owner-only Unix socket of the local listener. */
export const DAEMON_SOCKET_FILE = 'run/fyd.sock';
export const DAEMON_RUN_FORMAT = 1 as const;

export const DaemonRunSchema = z.strictObject({
  format: z.literal(DAEMON_RUN_FORMAT),
  /** Absolute path of the Unix socket. */
  socket: z.string().min(1),
  /** The loopback port's bind host and port. */
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  pid: z.number().int().positive(),
  version: z.string().min(1),
});
export type DaemonRun = z.infer<typeof DaemonRunSchema>;

/**
 * The address a local client dials (P89): the recorded bind, never a public URL; a wildcard bind resolves to loopback
 * at the recorded port. Pure.
 */
export function recordedBindAddress(bind: Pick<DaemonRun, 'host' | 'port'>): string {
  const host = bind.host === '0.0.0.0' || bind.host === '::' || bind.host === '' ? '127.0.0.1' : bind.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${bind.port}`;
}
