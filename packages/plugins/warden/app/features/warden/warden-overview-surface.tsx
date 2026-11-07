/**
 * The daemon-bound host of the Warden page: it reads the status and the Warden's notification count, runs the
 * owner's sweep and leave requests, and opens reports — all through the ONE paired connection it
 * was given, so nothing read from one daemon is shown or acted on through another.
 *
 * Everything below is keyed by the daemon id, so a switch to another paired daemon mounts a fresh body:
 * a late answer, a notice or an in-flight request from the previous one cannot reach the screen.
 *
 * SWEEP NOW is the free deterministic sweep (`spawn: false`): it flags, and whatever the triage then does
 * is the configured triage's business. LEAVE IT LONGER keeps the Warden off a
 * flagged or cleared ferret for a while; the daemon's sentence says for how long.
 */

import { useCallback, useState } from 'react';

import { useWardenPoll, type WardenPollOptions } from '../../hooks/use-warden-poll.ts';
import { useWardenClientFactory, type WardenClientFactory } from '../../lib/warden-client-context.tsx';
import type { WardenClient } from '../../lib/warden-client.ts';
import { type DaemonConnection, daemonSettingsPath, type FerretView, shellClock } from '../../shell.ts';
import type { WardenLeaveDuration } from '../../wire.ts';
import type { WardenReportTarget } from './warden-overview-model.ts';
import { type WardenNotice, WardenOverview } from './warden-overview.tsx';
import { WardenReportDialog, type WardenReportDialogRequest } from './warden-report-dialog.tsx';

export type WardenOverviewClient = WardenClient;
export type WardenOverviewClientFactory = WardenClientFactory;

export interface WardenOverviewSurfaceProps {
  readonly connection: DaemonConnection;
  readonly machineName?: string;
  readonly ferrets?: readonly FerretView[] | null;
  readonly onNavigate?: (to: string) => void;
  /** Test and harness seam; production uses the carrier-routed client. */
  readonly createClient?: WardenOverviewClientFactory;
  readonly now?: () => number;
  readonly pollOptions?: Omit<WardenPollOptions, 'revision'>;
}

/** Settings › Warden for one daemon. */
export const wardenSettingsHref = (connection: DaemonConnection): string =>
  `${daemonSettingsPath(connection.daemonId)}#warden`;

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function WardenOverviewSurface(props: WardenOverviewSurfaceProps) {
  return <WardenOverviewBody key={props.connection.daemonId} {...props} />;
}

function WardenOverviewBody({
  connection,
  machineName,
  ferrets = null,
  onNavigate,
  createClient: injected,
  now = shellClock.nowMs,
  pollOptions = {},
}: WardenOverviewSurfaceProps) {
  const routed = useWardenClientFactory();
  const createClient: WardenOverviewClientFactory = injected ?? routed;
  const [revision, setRevision] = useState(0);
  const [sweeping, setSweeping] = useState(false);
  const [notice, setNotice] = useState<WardenNotice | null>(null);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [report, setReport] = useState<WardenReportDialogRequest | null>(null);

  const readStatus = useCallback(
    async (daemon: DaemonConnection) => await (await createClient(daemon)).status(),
    [createClient],
  );
  const readAgenda = useCallback(
    async (daemon: DaemonConnection) => await (await createClient(daemon)).agenda(),
    [createClient],
  );
  const readReport = useCallback(
    async (daemon: DaemonConnection, reportPath: string) => await (await createClient(daemon)).report(reportPath),
    [createClient],
  );
  const status = useWardenPoll(connection, readStatus, { ...pollOptions, revision });
  const agenda = useWardenPoll(connection, readAgenda, { ...pollOptions, revision });

  const sweep = async (): Promise<void> => {
    setSweeping(true);
    setNotice(null);
    try {
      const run = await (await createClient(connection)).run(false);
      const flagged = run.flags.length;
      setNotice({
        tone: 'ok',
        text: run.message ?? `Swept: ${flagged === 0 ? 'nothing flagged' : `${flagged} flagged`}.`,
      });
    } catch (cause) {
      setNotice({ tone: 'err', text: `The sweep did not run: ${reasonOf(cause)}` });
    } finally {
      setSweeping(false);
      setRevision(current => current + 1);
    }
  };

  const leave = async (ferret: string, duration: WardenLeaveDuration): Promise<void> => {
    setLeaving(current => new Set([...current, ferret]));
    setNotice(null);
    try {
      const answer = await (await createClient(connection)).leave({ ferret, duration });
      setNotice({ tone: 'ok', text: answer.message });
    } catch (cause) {
      setNotice({ tone: 'err', text: `Not left alone: ${reasonOf(cause)}` });
    } finally {
      setLeaving(current => new Set([...current].filter(id => id !== ferret)));
      setRevision(current => current + 1);
    }
  };

  const openReport = (row: WardenReportTarget): void => {
    setReport({
      connection,
      verdict: {
        at: row.at ?? '',
        ...(row.ferret === undefined ? {} : { target: row.ferret }),
        verdict: row.verdict ?? 'unknown',
        reportPath: row.reportPath,
      },
      ...(row.jev === undefined ? {} : { jev: row.jev }),
    });
  };

  return (
    <>
      <WardenOverview
        connection={connection}
        {...(machineName === undefined ? {} : { machineName })}
        status={status}
        attention={agenda}
        ferrets={ferrets}
        now={now()}
        sweeping={sweeping}
        notice={notice}
        settingsHref={wardenSettingsHref(connection)}
        {...(onNavigate === undefined ? {} : { onNavigate })}
        onSweep={() => void sweep()}
        onLeave={(ferret, duration) => void leave(ferret, duration)}
        leaving={leaving}
        onOpenReport={openReport}
      />
      <WardenReportDialog request={report} read={readReport} onClose={() => setReport(null)} />
    </>
  );
}
