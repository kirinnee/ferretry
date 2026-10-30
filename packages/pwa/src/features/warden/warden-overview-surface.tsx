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

import type { IFyApiClient, SessionView, WardenLeaveDuration } from '@ferretry/protocol';
import { useCallback, useState } from 'react';

import { useWardenPoll, type WardenPollOptions } from '../../hooks/use-warden-poll.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonSettingsPath } from '../../lib/pages/routes.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import type { WardenReportTarget } from './warden-overview-model.ts';
import { type WardenNotice, WardenOverview } from './warden-overview.tsx';
import { WardenReportDialog, type WardenReportDialogRequest } from './warden-report-dialog.tsx';

export type WardenOverviewClient = Pick<
  IFyApiClient,
  'wardenStatus' | 'wardenAttention' | 'wardenRun' | 'wardenLeave' | 'wardenReport'
>;
export type WardenOverviewClientFactory = (connection: DaemonConnection) => Promise<WardenOverviewClient>;

export interface WardenOverviewSurfaceProps {
  readonly connection: DaemonConnection;
  readonly sessions?: readonly SessionView[] | null;
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
  sessions = null,
  onNavigate,
  createClient: injected,
  now = Date.now,
  pollOptions = {},
}: WardenOverviewSurfaceProps) {
  const routed = useDaemonClient();
  const createClient: WardenOverviewClientFactory = injected ?? routed;
  const [revision, setRevision] = useState(0);
  const [sweeping, setSweeping] = useState(false);
  const [notice, setNotice] = useState<WardenNotice | null>(null);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [report, setReport] = useState<WardenReportDialogRequest | null>(null);

  const readStatus = useCallback(
    async (daemon: DaemonConnection) => await (await createClient(daemon)).wardenStatus(),
    [createClient],
  );
  const readAttention = useCallback(
    async (daemon: DaemonConnection) => await (await createClient(daemon)).wardenAttention(),
    [createClient],
  );
  const readReport = useCallback(
    async (daemon: DaemonConnection, reportPath: string) => await (await createClient(daemon)).wardenReport(reportPath),
    [createClient],
  );
  const status = useWardenPoll(connection, readStatus, { ...pollOptions, revision });
  const attention = useWardenPoll(connection, readAttention, { ...pollOptions, revision });

  const sweep = async (): Promise<void> => {
    setSweeping(true);
    setNotice(null);
    try {
      const run = await (await createClient(connection)).wardenRun(false);
      const flagged = run.anomalies.length;
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

  const leave = async (sessionId: string, duration: WardenLeaveDuration): Promise<void> => {
    setLeaving(current => new Set([...current, sessionId]));
    setNotice(null);
    try {
      const answer = await (await createClient(connection)).wardenLeave({ sessionId, duration });
      setNotice({ tone: 'ok', text: answer.message });
    } catch (cause) {
      setNotice({ tone: 'err', text: `Not left alone: ${reasonOf(cause)}` });
    } finally {
      setLeaving(current => new Set([...current].filter(id => id !== sessionId)));
      setRevision(current => current + 1);
    }
  };

  const openReport = (row: WardenReportTarget): void => {
    setReport({
      connection,
      verdict: {
        at: row.at ?? '',
        ...(row.sessionId === undefined ? {} : { targetSession: row.sessionId }),
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
        status={status}
        attention={attention}
        sessions={sessions}
        now={now()}
        sweeping={sweeping}
        notice={notice}
        settingsHref={wardenSettingsHref(connection)}
        {...(onNavigate === undefined ? {} : { onNavigate })}
        onSweep={() => void sweep()}
        onLeave={(sessionId, duration) => void leave(sessionId, duration)}
        leaving={leaving}
        onOpenReport={openReport}
      />
      <WardenReportDialog request={report} read={readReport} onClose={() => setReport(null)} />
    </>
  );
}
