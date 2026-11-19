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
 * A refused read is said in words, with the machine's own sentence and the one place the log is always
 * readable — the machine itself — rather than as an empty list, which would read as "nothing has
 * happened". The WORDS FOLLOW THE REFUSAL'S OWN CODE: a machine whose owner switched pairing off for
 * other devices, one that has not granted THIS device, and one that wants a passkey this device did not
 * confirm are three different situations with three different remedies, and saying "pairing is switched
 * off" to a person who merely cancelled the passkey card sends them to change a setting that is fine.
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

import { ConfirmToSee, Loading } from '@ferretry/app/ui';
import type { AuditView } from '@ferretry/core-gate/contract';
import { SettingGroup } from '@ferretry/app';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

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
import type { DaemonConnection } from '../../shell-grants.ts';
import { grantRefusalNotice } from '../../lib/grants.ts';
import { readSecurityLog, type SecurityLogClient } from './security-api.ts';
import { AccessTab, ActionRow, Notice, StateBlock } from './access-kit.tsx';

type AuditRecord = AuditView['records'][number];

export type SecurityLogClientFactory = (connection: DaemonConnection) => Promise<SecurityLogClient>;

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly view: AuditView; readonly older: OlderState }
  | { readonly status: 'refused'; readonly why: RefusalKind; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

/** The security changes paged in past the first page, and whether a page is being read. */
interface OlderState {
  readonly kept: readonly AuditRecord[];
  readonly reading: boolean;
  readonly failure: string | null;
}

const NO_OLDER: OlderState = { kept: [], reading: false, failure: null };

/** Which refusal the machine gave: its own code decides the words, never the status alone. */
export type RefusalKind = 'pairing-off' | 'this-device' | 'passkey' | 'other';

/** What the daemon's refusal code names; a 403 with no grant code is 'other' and is not guessed at. */
export function refusalKindOf(cause: unknown): RefusalKind {
  switch (grantRefusalNotice(cause)?.refusal) {
    case 'not-granted':
      return 'pairing-off';
    case 'device-not-granted':
      return 'this-device';
    case 'step-up-required':
      return 'passkey';
    default:
      return 'other';
  }
}

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause)).trim();

export const SECURITY_REFUSED_REMEDY =
  'The log is always readable on the machine itself: open Ferretry there, or run fy daemon audit in its terminal.';
export const SECURITY_REFUSED_INTRO =
  'This machine does not let other devices read its security log, because its owner has switched pairing off for them.';
export const SECURITY_PASSKEY_INTRO =
  "Reading this machine's security log from this device needs your passkey, and it was not confirmed. Pairing is still on.";
export const SECURITY_PASSKEY_REMEDY =
  'Press the button to be asked for your passkey again, or read the log on the machine itself: open Ferretry there, or run fy daemon audit in its terminal.';
export const SECURITY_THIS_DEVICE_INTRO = 'This machine has not given this device permission to read its security log.';
const SECURITY_OTHER_INTRO = "This machine refused this device's read of its security log.";

/** The heading, first sentence and closing line for each kind of refusal. */
export const REFUSAL_WORDS: Readonly<
  Record<RefusalKind, { readonly heading: string; readonly intro: string; readonly remedy: string }>
> = {
  'pairing-off': {
    heading: 'The security log is not shown on other devices',
    intro: SECURITY_REFUSED_INTRO,
    remedy: SECURITY_REFUSED_REMEDY,
  },
  'this-device': {
    heading: 'This device may not read the security log',
    intro: SECURITY_THIS_DEVICE_INTRO,
    remedy: SECURITY_REFUSED_REMEDY,
  },
  passkey: {
    heading: 'Confirm with your passkey to read the security log',
    intro: SECURITY_PASSKEY_INTRO,
    remedy: SECURITY_PASSKEY_REMEDY,
  },
  other: {
    heading: 'The security log is not shown on this device',
    intro: SECURITY_OTHER_INTRO,
    remedy: SECURITY_REFUSED_REMEDY,
  },
};

function SecurityRow({ record, nowMs }: { readonly record: AuditRecord; readonly nowMs: number }) {
  const badge = auditOutcomeBadge(record.outcome);
  const detail = auditDetailWords(record);
  return (
    <li className="fy-acc-log min-w-0" data-security-log-event={record.event}>
      <div className="fy-acc-log__head">
        <span className="fy-acc-log__what">
          {/* An event this build has no words for is shown as its raw name, never dropped. */}
          {(AUDIT_EVENT_WORDS as Readonly<Record<string, string>>)[record.event] ?? record.event}
        </span>
        {badge === null ? null : (
          <span className="fy-acc-chip" data-tone="plain" data-security-log-outcome={record.outcome}>
            {badge}
          </span>
        )}
      </div>
      <p className="fy-acc-log__when">
        <time dateTime={record.at} title={absoluteWords(record.at)}>
          {relativeWords(record.at, nowMs)}
        </time>
        {' · by '}
        <span className="text-fg">{auditActorWords(record.actor)}</span>
      </p>
      {detail === '' ? null : (
        <p className="fy-acc-fine" data-security-log-detail="">
          {detail}
        </p>
      )}
    </li>
  );
}

function SecurityList({ records, nowMs }: { readonly records: readonly AuditRecord[]; readonly nowMs: number }) {
  return (
    <>
      {records.map((record, index) => (
        // Records have no id; a list only ever grows at its end while mounted, so position is stable.
        <SecurityRow key={`${record.at}-${String(index)}`} record={record} nowMs={nowMs} />
      ))}
    </>
  );
}

/** A group that has nothing yet says so in one row. */
const NoneYet = () => (
  <li className="fy-acc-log min-w-0">
    <p className="fy-acc-fine">None yet.</p>
  </li>
);

/** The loaded log, separated from the read so its every state can be rendered without a client. */
function SecurityLog({
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
    <AccessTab name="audit">
      <section aria-labelledby="security-log-heading" data-security-log-panel="">
        <h3 id="security-log-heading" className="sr-only">
          Security log
        </h3>
        <p className="fy-acc-fine fy-acc-lead">
          Who was paired or removed and what changed about who may reach this machine, then the recent activity: refused
          attempts, opened terminals, used secrets. Newest first.
        </p>
        {view.unreadable > 0 ? (
          <Notice
            tone="warn"
            role="alert"
            icon={<TriangleAlert size={14} />}
            marks={{ 'data-security-log-gaps': String(view.unreadable) }}
          >
            {securityLogGapWarning(view.unreadable)}
          </Notice>
        ) : null}
        {view.records.length === 0 && view.keptTotal === 0 ? (
          <p className="fy-acc-fine text-fg" data-security-log-empty="">
            {SECURITY_LOG_EMPTY}
          </p>
        ) : (
          <>
            <div data-security-log-section="kept">
              <SettingGroup label="Security changes">
                {kept.length === 0 ? <NoneYet /> : <SecurityList records={kept} nowMs={nowMs} />}
                {remaining > 0 ? (
                  <li className="fy-acc-log min-w-0">
                    <ActionRow>
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
                        <span role="alert" className="min-w-0 text-cell text-err" data-security-log-older-failed="">
                          {older.failure}
                        </span>
                      )}
                    </ActionRow>
                  </li>
                ) : null}
              </SettingGroup>
            </div>
            <div data-security-log-section="activity">
              <SettingGroup label="Recent activity">
                {view.records.length === 0 ? <NoneYet /> : <SecurityList records={view.records} nowMs={nowMs} />}
              </SettingGroup>
            </div>
          </>
        )}
      </section>
    </AccessTab>
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

  /** How many times the owner pressed "Confirm it's you to see this"; the read after a press is theirs. */
  const [reads, setReads] = useState(0);

  useEffect(() => {
    let current = true;
    setState({ daemonId: connection.daemonId, load: { status: 'loading' } });
    void createClient(connection)
      .then(async client => await readSecurityLog(client, undefined, 0, reads > 0))
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
              ? { status: 'refused', why: refusalKindOf(cause), reason: reasonOf(cause) }
              : { status: 'failed', reason: reasonOf(cause) },
        });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient, reads]);

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
      <StateBlock
        title={REFUSAL_WORDS[load.why].heading}
        label="Security log unavailable"
        marks={{ 'data-security-log-refused': '' }}
      >
        <p className="fy-acc-fine">{REFUSAL_WORDS[load.why].intro}</p>
        {load.reason === '' ? null : <p className="fy-acc-fine">{load.reason}</p>}
        {load.why === 'passkey' ? <ConfirmToSee onConfirm={() => setReads(n => n + 1)} /> : null}
        <p className="fy-acc-fine text-fg">{REFUSAL_WORDS[load.why].remedy}</p>
      </StateBlock>
    );
  if (load.status === 'failed')
    return (
      <StateBlock
        title="The security log could not be read"
        label="Security log unavailable"
        role="alert"
        icon={<CircleAlert size={16} aria-hidden="true" className="text-err" />}
        marks={{ 'data-security-log-failed': '' }}
      >
        <p className="fy-acc-fine">
          {load.reason === '' ? 'This machine did not say why.' : load.reason} This is not an empty history — nothing
          was read at all.
        </p>
      </StateBlock>
    );
  return <Loading kind="page" label="Reading this machine’s security log…" />;
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
