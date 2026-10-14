/**
 * SETTINGS › SECURITY LOG: what has happened to who can reach this machine, in plain words.
 *
 * The daemon keeps an append-only log of every pairing, removal, refused attempt, permission change,
 * opened terminal and used secret. This panel reads the most recent of them for ONE machine — through
 * the connection it was handed, so switching machines never shows another machine's history — and
 * lists them newest first: when, what, who, and a quiet badge when something was refused or failed.
 *
 * ## A DAMAGED LOG IS SAID TO BE DAMAGED
 *
 * The daemon counts the lines it could not read and sends the count with the records. A non-zero count
 * is a warning row above the list, never dropped: a history with holes in it that reads as complete is
 * the one thing a security log must not do.
 *
 * ## A REFUSAL IS EXPLAINED
 *
 * A machine whose owner switched pairing off for other devices refuses this read. That is said in
 * words, with the machine's own sentence and the one place the log is always readable — the machine
 * itself — rather than as an empty list, which would read as "nothing has happened".
 *
 * ## SECURITY CHANGES COME FIRST, AND NOTHING CAN PUSH THEM OFF THE PAGE
 *
 * The daemon returns pairings, removals and permission changes as a list of their own, apart from the
 * activity, and this panel shows that list first with a "Show older" button that pages back until every
 * one has been shown. A device that re-attaches to a terminal ten thousand times fills the activity
 * list, not this one.
 *
 * ## LOOKING HERE MARKS ONLY WHAT WAS SHOWN
 *
 * The new-device notice stops announcing a device once somebody has seen it. This panel counts as having
 * seen a device only when the device's pairing record is actually on screen — never on open, never on a
 * refused or failed read — so opening Security cannot make an attacker's pairing disappear unseen.
 */

import type { AuditRecord, AuditView } from '@ferretry/protocol';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  AUDIT_EVENT_WORDS,
  absoluteWords,
  auditActorWords,
  auditDetailWords,
  auditOutcomeBadge,
  pairedDevicesShown,
  relativeWords,
  SECURITY_LOG_EMPTY,
  securityLogGapWarning,
} from '../../lib/security-log.ts';
import { announceDevicesLooked } from '../device-notice/devices-looked.ts';
import { readSecurityLog, type SecurityLogClient } from './security-api.ts';

export type SecurityLogClientFactory = (connection: DaemonConnection) => Promise<SecurityLogClient>;

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly view: AuditView; readonly older: OlderState }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

/** The security changes paged in past the first page, and whether a page is being read. */
interface OlderState {
  readonly kept: readonly AuditRecord[];
  readonly reading: boolean;
  readonly failure: string | null;
}

const NO_OLDER: OlderState = { kept: [], reading: false, failure: null };

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause)).trim();

export const SECURITY_REFUSED_INTRO =
  'This machine does not let other devices read its security log, because its owner has switched pairing off for them.';
export const SECURITY_REFUSED_REMEDY =
  'The log is always readable on the machine itself: open Ferretry there, or run fy daemon audit in its terminal.';

function SecurityRow({ record, nowMs }: { readonly record: AuditRecord; readonly nowMs: number }) {
  const badge = auditOutcomeBadge(record.outcome);
  const detail = auditDetailWords(record);
  return (
    <li
      className="flex min-w-0 flex-col gap-0.5 border-t border-border py-2 first:border-t-0 first:pt-0 last:pb-0"
      data-security-log-event={record.event}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="min-w-0 text-ui font-semibold text-fg">{AUDIT_EVENT_WORDS[record.event]}</span>
        {badge === null ? null : (
          <span
            className="rounded-control border border-border-strong bg-surface-2 px-1.5 py-px text-meta font-medium text-muted"
            data-security-log-outcome={record.outcome}
          >
            {badge}
          </span>
        )}
      </div>
      <p className="m-0 min-w-0 text-meta leading-base text-muted">
        <time dateTime={record.at} title={absoluteWords(record.at)}>
          {relativeWords(record.at, nowMs)}
        </time>
        {' · by '}
        <span className="break-words text-fg">{auditActorWords(record.actor)}</span>
      </p>
      {detail === '' ? null : (
        <p className="m-0 min-w-0 break-words text-meta leading-base text-muted" data-security-log-detail="">
          {detail}
        </p>
      )}
    </li>
  );
}

function SecurityList({ records, nowMs }: { readonly records: readonly AuditRecord[]; readonly nowMs: number }) {
  return (
    <ul className="m-0 mt-1 list-none p-0">
      {records.map((record, index) => (
        // Records have no id; a list only ever grows at its end while mounted, so position is stable.
        <SecurityRow key={`${record.at}-${String(index)}`} record={record} nowMs={nowMs} />
      ))}
    </ul>
  );
}

/** The loaded log, separated from the read so its every state can be rendered without a client. */
export function SecurityLog({
  view,
  nowMs,
  older = NO_OLDER,
  onShowOlder,
}: {
  readonly view: AuditView;
  readonly nowMs: number;
  readonly older?: OlderState;
  readonly onShowOlder?: () => void;
}) {
  const kept = [...view.kept, ...older.kept];
  const remaining = view.keptTotal - kept.length;
  return (
    <section
      className="kt-panel flex min-w-0 flex-col gap-2 p-panel"
      aria-labelledby="security-log-heading"
      data-security-log-panel=""
    >
      <h3 id="security-log-heading" className="m-0 text-row font-semibold text-fg">
        Security log
      </h3>
      <p className="m-0 text-cell leading-base text-muted">
        Who was paired or removed and what changed about who may reach this machine, then the recent activity: refused
        attempts, opened terminals, used secrets. Newest first.
      </p>
      {view.unreadable > 0 ? (
        <p
          role="alert"
          data-security-log-gaps={String(view.unreadable)}
          className="m-0 flex items-start gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
        >
          <TriangleAlert size={14} aria-hidden="true" className="mt-1 shrink-0" />
          <span className="min-w-0">{securityLogGapWarning(view.unreadable)}</span>
        </p>
      ) : null}
      {view.records.length === 0 && view.keptTotal === 0 ? (
        <p className="m-0 text-ui leading-base text-fg" data-security-log-empty="">
          {SECURITY_LOG_EMPTY}
        </p>
      ) : (
        <>
          <h4 className="m-0 mt-1 text-ui font-semibold text-fg" data-security-log-section="kept">
            Security changes
          </h4>
          {kept.length === 0 ? (
            <p className="m-0 text-cell leading-base text-muted">None yet.</p>
          ) : (
            <SecurityList records={kept} nowMs={nowMs} />
          )}
          {remaining > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <button
                type="button"
                className="kt-btn min-h-[44px]"
                data-security-log-older=""
                disabled={older.reading}
                onClick={onShowOlder}
              >
                {older.reading ? 'Reading…' : `Show older (${String(remaining)} more)`}
              </button>
              {older.failure === null ? null : (
                <span role="alert" className="min-w-0 text-cell leading-base text-err" data-security-log-older-failed="">
                  {older.failure}
                </span>
              )}
            </div>
          ) : null}
          <h4 className="m-0 mt-2 text-ui font-semibold text-fg" data-security-log-section="activity">
            Recent activity
          </h4>
          {view.records.length === 0 ? (
            <p className="m-0 text-cell leading-base text-muted">None yet.</p>
          ) : (
            <SecurityList records={view.records} nowMs={nowMs} />
          )}
        </>
      )}
    </section>
  );
}

export function SecurityLogSurface({
  connection,
  createClient,
  now = Date.now,
}: {
  readonly connection: DaemonConnection;
  readonly createClient: SecurityLogClientFactory;
  readonly now?: () => number;
}) {
  const [state, setState] = useState<{ readonly daemonId: DaemonConnection['daemonId']; readonly load: LoadState }>({
    daemonId: connection.daemonId,
    load: { status: 'loading' },
  });

  useEffect(() => {
    let current = true;
    setState({ daemonId: connection.daemonId, load: { status: 'loading' } });
    void createClient(connection)
      .then(async client => await readSecurityLog(client))
      .then(view => {
        if (!current) return;
        setState({ daemonId: connection.daemonId, load: { status: 'loaded', view, older: NO_OLDER } });
        // Only now, and only the pairings this page puts on screen: see the module comment.
        announceDevicesLooked(connection.daemonId, pairedDevicesShown(view.kept));
      })
      .catch((cause: unknown) => {
        if (!current) return;
        const status = (cause as { readonly status?: unknown } | null)?.status;
        setState({
          daemonId: connection.daemonId,
          load:
            status === 403
              ? { status: 'refused', reason: reasonOf(cause) }
              : { status: 'failed', reason: reasonOf(cause) },
        });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  const showOlder = useCallback(() => {
    const daemonId = connection.daemonId;
    const loaded = state.load;
    if (state.daemonId !== daemonId || loaded.status !== 'loaded') return;
    // Counted from the newest: a change recorded since the first read shifts the page by one, so a row
    // can repeat at the boundary but never be skipped.
    const offset = loaded.view.kept.length + loaded.older.kept.length;
    const update = (older: OlderState): void =>
      setState(previous =>
        previous.daemonId === daemonId && previous.load.status === 'loaded'
          ? { daemonId, load: { ...previous.load, older } }
          : previous,
      );
    update({ ...loaded.older, reading: true, failure: null });
    void createClient(connection)
      .then(async client => await readSecurityLog(client, undefined, offset))
      .then(page => {
        update({ kept: [...loaded.older.kept, ...page.kept], reading: false, failure: null });
        announceDevicesLooked(daemonId, pairedDevicesShown(page.kept));
      })
      .catch((cause: unknown) => {
        update({ ...loaded.older, reading: false, failure: reasonOf(cause) || 'The older changes could not be read.' });
      });
  }, [connection, createClient, state]);

  const load: LoadState = state.daemonId === connection.daemonId ? state.load : { status: 'loading' };
  if (load.status === 'loaded')
    return <SecurityLog view={load.view} nowMs={now()} older={load.older} onShowOlder={showOlder} />;
  if (load.status === 'refused')
    return (
      <section
        className="kt-panel p-panel"
        role="status"
        aria-label="Security log unavailable"
        data-security-log-refused=""
      >
        <h3 className="m-0 text-row font-semibold text-fg">The security log is not shown on other devices</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">{SECURITY_REFUSED_INTRO}</p>
        {load.reason === '' ? null : <p className="mb-0 mt-1 text-cell leading-base text-muted">{load.reason}</p>}
        <p className="mb-0 mt-1 text-cell leading-base text-fg">{SECURITY_REFUSED_REMEDY}</p>
      </section>
    );
  if (load.status === 'failed')
    return (
      <section className="kt-panel p-panel" role="alert" aria-label="Security log unavailable" data-security-log-failed="">
        <h3 className="m-0 flex items-center gap-2 text-row font-semibold text-fg">
          <CircleAlert size={16} aria-hidden="true" className="text-err" />
          The security log could not be read
        </h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          {load.reason === '' ? 'This machine did not say why.' : load.reason} This is not an empty history — nothing
          was read at all.
        </p>
      </section>
    );
  return (
    <section className="kt-panel p-panel" role="status" aria-label="Loading the security log">
      <p className="m-0 text-cell leading-base text-muted">Reading this machine’s security log…</p>
    </section>
  );
}

/** The Settings panel, for the composition root's `daemonSettingsTabs`, bound to the app's client pool. */
export const securityLogSettingsTab = (createClient: SecurityLogClientFactory) =>
  ({
    id: 'security-log',
    label: 'Security log',
    description: 'Recent pairings, removals, refused attempts and other security events on this machine.',
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <SecurityLogSurface connection={connection} createClient={createClient} />
    ),
  }) as const;
