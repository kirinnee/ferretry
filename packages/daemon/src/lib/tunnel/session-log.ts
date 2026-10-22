/**
 * WHAT THE DAEMON LOGS ABOUT A TUNNEL SESSION — `docs/relay-protocol.md` §15, "What the daemon logs".
 *
 * A phone on the tunnel carrier that "keeps reconnecting" while `cloudflared` stays registered is a
 * per-session fact, and the only end that sees every session's whole life is this one. So each tunnel
 * session's open and close is one line in the daemon log: who ended it, the close code and reason, how
 * long it lived, how long before the end the last client frame arrived (a `fy-ping` counts), and the
 * bytes each way. Nothing in it is a credential, a device or an address — an owner can paste it.
 */

import type { DirectSessionEnd, DirectSessionLog } from '../relay/direct-carrier.ts';
import type { TunnelCarrierNotices } from './carrier.ts';

/** What the close codes a tunnel session usually ends with mean, in the words an owner reads. */
const CLOSE_MEANINGS: Readonly<Record<number, string>> = {
  1000: 'closed normally',
  1001: 'going away — a page left, or Cloudflare restarted the connection',
  1006: 'no close frame — the connection was cut',
  1011: 'an internal error at the far end',
  1012: 'the far end is restarting',
  4408: 'no heartbeat answered in time',
};

/** A reason as one printable line, so a peer's close text cannot forge a second log line. */
const printable = (reason: string): string =>
  reason
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, ' ')
    .trim()
    .slice(0, 123);

/** `12m 03s`, `4.2s`, `850ms` — a duration at the precision that matters for it. */
export const describeDuration = (milliseconds: number): string => {
  const ms = Math.max(0, Math.round(milliseconds));
  if (ms < 1_000) return `${String(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const totalSeconds = Math.floor(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}h ${String(minutes).padStart(2, '0')}m ${seconds}s`
    : `${String(minutes)}m ${seconds}s`;
};

const describeBytes = (bytes: number): string =>
  bytes < 1_024
    ? `${String(bytes)} B`
    : bytes < 1_048_576
      ? `${(bytes / 1_024).toFixed(1)} KB`
      : `${(bytes / 1_048_576).toFixed(1)} MB`;

/** The detail of one `tunnel session closed` line. */
export const describeTunnelSessionEnd = (end: DirectSessionEnd): string => {
  const code = end.code === undefined ? 'no code' : String(end.code);
  const meaning = end.code === undefined ? undefined : CLOSE_MEANINGS[end.code];
  const reason = printable(end.reason);
  const said = [meaning, reason === '' ? undefined : `“${reason}”`].filter(part => part !== undefined).join(', ');
  return [
    `${code} by ${end.by === 'peer' ? 'the browser side' : 'this daemon'}${said === '' ? '' : ` (${said})`}`,
    `after ${describeDuration(end.durationMs)}`,
    `last frame ${describeDuration(end.lastFrameAgeMs)} before`,
    `${describeBytes(end.bytesIn)} in, ${describeBytes(end.bytesOut)} out`,
    end.proved ? 'device proved' : 'no device proved',
  ].join('; ');
};

/** The log a tunnel listener's sessions report to: milestones in the daemon's own journal. */
export const tunnelSessionLog = (notices: Pick<TunnelCarrierNotices, 'step'>): DirectSessionLog => ({
  opened: () => notices.step('tunnel session opened'),
  closed: end => notices.step('tunnel session closed', describeTunnelSessionEnd(end)),
});
