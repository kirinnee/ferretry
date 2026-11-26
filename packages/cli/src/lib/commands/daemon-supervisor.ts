/**
 * The supervisor half of `fy daemon status` (V-0243): what supervises the daemon, as today's status says it. The read
 * is the controller's (`supervision()`, through its process port); this file turns it, with the probe's own facts, into
 * the human lines and the `--json` keys. Today's keys {daemon, reachability, orphan, supervisor, health} sit BESIDE 5.0's
 * {running, baseUrl, version|why, protocol}, so a script reading either keeps working.
 */
import type { Health } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { DaemonSupervision } from '../daemon/controller.ts';
import type { DaemonSupervisorReport } from '../daemon/ports.ts';
import { livenessOf } from '../daemon/probe.ts';
import type { DaemonLiveness } from '../daemon/readiness.ts';
import type { ShellContext } from '../shell-context.ts';

/** What a status read of the supervisor came to: a read, a manager 5.0 does not ask, or a failure that is only said. */
export type SupervisorRead = DaemonSupervision | { readonly kind: 'failed'; readonly why: string };

/** The route Connections serves the tunnel's state on (the app's Connection panel and `fy tunnel` read the same one). */
const TUNNEL_ROUTE = 'GET /v1/tunnel';

/** Only the words of the tunnel view this verb prints: the daemon writes the sentence once (`fy tunnel` says the same). */
const TunnelWordsSchema = z.object({ state: z.string(), sentence: z.string() });
type TunnelWords = z.infer<typeof TunnelWordsSchema>;

/**
 * The tunnel's words, from the daemon while it serves. NOTHING, rather than a failure, for every reason the read can
 * fail (Connections off, an older daemon with no such route, a daemon that stopped since the probe): `status` reports on
 * the daemon and its exit code is the daemon's, so a tunnel that cannot be read is named in `notReported`, not an error.
 */
export async function readTunnel(ctx: ShellContext): Promise<TunnelWords | undefined> {
  try {
    return TunnelWordsSchema.parse(await ctx.client('connections').call(TUNNEL_ROUTE));
  } catch {
    return undefined;
  }
}

/**
 * The parts of today's status 5.0 has no read for, said in both outputs rather than left to look healthy. `firewall` is
 * always one (no Browsers state route says it); `liveness` is one only where the manager is not read (launchd, or a
 * read that failed), and `tunnel` only while the tunnel could not be read (the daemon is down, or Connections is off).
 */
const notReportedOf = (read: SupervisorRead, tunnel: TunnelWords | undefined): readonly string[] => [
  ...(read.kind === 'read' ? [] : ['liveness']),
  ...(tunnel === undefined ? ['tunnel'] : []),
  'firewall',
];

/** The supervisor's verdict on the process, as the readiness wait reads it: running is alive, failed is dead, else absent. */
const livenessRead = (read: SupervisorRead): DaemonLiveness | undefined =>
  read.kind === 'read' ? livenessOf(read.report) : undefined;

/**
 * Asks the controller what supervises the daemon. NEVER throws: `status` reports on the daemon and its exit code is the
 * daemon's, so a supervisor that cannot be read is a line, not a failure. Nothing here changes anything.
 */
export async function readSupervisor(ctx: ShellContext): Promise<SupervisorRead> {
  const { world } = ctx;
  if (world.daemon === undefined) return { kind: 'failed', why: 'this fy has no local daemon-control adapters' };
  try {
    // `status` uses neither read a stop or reset needs, so both are inert.
    const built = world.daemon({ resetInventory: { count: async () => undefined }, turns: { midTurn: async () => 0 } });
    return await built.controller.supervision();
  } catch (error) {
    return { kind: 'failed', why: error instanceof Error ? error.message : String(error) };
  }
}

/** The daemon is not answering, and its manager (if it names a running process) says one exists: today's `wedged`. */
const reachabilityOf = (up: boolean, read: SupervisorRead): 'serving' | 'wedged' | 'stopped' =>
  up ? 'serving' : read.kind === 'read' && read.report.state === 'running' ? 'wedged' : 'stopped';

const supervisorKeys = (read: SupervisorRead): Readonly<Record<string, unknown>> => {
  if (read.kind === 'read') {
    const { manager, state, pid, detail, loaded, lastExit, lastSignal, definition } = read.report;
    return {
      manager,
      state,
      ...(pid === undefined ? {} : { pid }),
      ...(detail === undefined || detail === '' ? {} : { detail }),
      // launchd's own facts, said once here and in the lines below: is the job loaded, how did it last exit or die, which plist.
      ...(loaded === undefined ? {} : { loaded }),
      ...(lastExit === undefined ? {} : { lastExit }),
      ...(lastSignal === undefined ? {} : { lastSignal }),
      ...(definition === undefined ? {} : { definition }),
    };
  }
  return read.kind === 'unread'
    ? { manager: read.manager, state: 'not-reported', detail: unreadSentence(read.manager, read.why) }
    : { manager: 'unknown', state: 'not-reported', detail: read.why };
};

/** `daemon`, `reachability`, `orphan`, `supervisor`, `health` and `notReported`: today's keys, for `--json` to add. */
export function supervisorJson(
  read: SupervisorRead,
  probe: { readonly up: boolean; readonly health?: Health | undefined; readonly tunnel?: TunnelWords | undefined },
): Readonly<Record<string, unknown>> {
  const liveness = livenessRead(read);
  return {
    ...(read.kind === 'failed' ? {} : { daemon: read.daemon }),
    reachability: reachabilityOf(probe.up, read),
    orphan: read.kind === 'read' && read.orphan,
    supervisor: supervisorKeys(read),
    ...(liveness === undefined ? {} : { liveness }),
    ...(probe.tunnel === undefined ? {} : { tunnel: probe.tunnel }),
    ...(probe.health === undefined
      ? {}
      : { health: { ...probe.health, ...(read.kind === 'read' && read.pid !== undefined ? { pid: read.pid } : {}) } }),
    notReported: notReportedOf(read, probe.tunnel),
  };
}

const unreadSentence = (manager: string, why: string): string => `${manager} could not be read: ${why}`;

const detailOf = (report: DaemonSupervisorReport): string =>
  report.detail === undefined || report.detail === '' ? '' : ` (${report.detail})`;

/** launchd's facts under its state line: loaded or not, the last exit status, and the plist it was read from. */
function launchdFacts(report: DaemonSupervisorReport): readonly string[] {
  if (report.manager !== 'launchd' || report.loaded === undefined) return [];
  const parts = [
    `loaded: ${report.loaded ? 'yes' : 'no'}`,
    ...(report.lastExit === undefined ? [] : [`last exit: ${String(report.lastExit)}`]),
    ...(report.lastSignal === undefined ? [] : [`last signal: ${report.lastSignal}`]),
    `plist: ${report.definition ?? 'not installed'}`,
  ];
  return [`    ${parts.join('; ')}`];
}

/** Today's supervisor line: the manager and its state, or that none manages the daemon. */
function supervisorLine(read: SupervisorRead): string {
  if (read.kind === 'unread') return `  ${read.manager}: not read — ${read.why}`;
  if (read.kind === 'failed') return `  supervisor not read: ${read.why}`;
  const { report } = read;
  return report.manager === 'direct'
    ? '  not managed by a service manager'
    : [`  ${report.manager}: ${report.state}${detailOf(report)}`, ...launchdFacts(report)].join('\n');
}

/** `Liveness: alive|dead|absent`, where the manager was read. */
const livenessLines = (read: SupervisorRead): readonly string[] => {
  const liveness = livenessRead(read);
  return liveness === undefined ? [] : [`Liveness: ${liveness}`];
};

/** The lines `status` adds under the 5.0 ones, and the remedy (said on the error stream, as today's does) for an orphan. */
export function supervisorLines(
  read: SupervisorRead,
  binary: string,
  tunnel?: TunnelWords,
): { readonly lines: readonly string[]; readonly remedy?: string } {
  const orphan = read.kind === 'read' && read.orphan;
  const pid = read.kind === 'read' ? (read.pid ?? read.report.pid) : undefined;
  return {
    lines: [
      ...(orphan && read.kind === 'read'
        ? [`${read.daemon} is serving, but OUTSIDE ${read.report.manager} — nothing supervises it`]
        : []),
      ...(pid === undefined ? [] : [`pid      ${String(pid)}`]),
      supervisorLine(read),
      ...livenessLines(read),
      ...(tunnel === undefined ? [] : [`Tunnel: ${tunnel.sentence}`]),
      `not reported in 5.0: ${notReportedOf(read, tunnel).join(', ')}`,
    ],
    ...(orphan && read.kind === 'read' && read.pid !== undefined
      ? {
          remedy:
            `pid ${String(read.pid)} was not started by ${read.report.manager}, so ${read.report.manager} cannot start its own; ` +
            `run ${binary} daemon restart to stop it and have ${read.report.manager} own the daemon`,
        }
      : {}),
  };
}

/** What a daemon that does not answer adds: the supervisor line, and today's `wedged` words when a process exists. */
export function downLines(read: SupervisorRead, binary: string): readonly string[] {
  const wedged =
    reachabilityOf(false, read) === 'wedged' && read.kind === 'read'
      ? [
          `  a process exists${read.report.pid === undefined ? '' : ` (pid ${String(read.report.pid)})`} but answered nothing in time — its event loop looks stalled or wedged`,
          `  \`${binary} daemon logs\` shows the last step and any stall it reported; \`${binary} daemon restart\` replaces it`,
        ]
      : [];
  return [supervisorLine(read), ...livenessLines(read), ...wedged];
}
