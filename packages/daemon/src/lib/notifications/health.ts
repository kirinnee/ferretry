import type { DoctorCheck } from '@ferretry/protocol';
import type { NotificationLedgerHealth } from './types.ts';

/** One push this daemon tried since it started, as its diagnostics heard it. */
export interface NotificationAttempt {
  readonly at: string;
  readonly key: string;
}

/** A push that could not be made, or that the push fan-out refused. */
export interface NotificationFailure extends NotificationAttempt {
  readonly reason: string;
}

/** Everything `fy doctor` reports about this daemon's pushes. */
export interface NotificationHealthReading {
  /** Devices enrolled for push now. */
  readonly enrolled: number;
  readonly ledger: NotificationLedgerHealth;
  /** The newest push that failed since this daemon started. */
  readonly lastFailed?: NotificationFailure;
  /** The newest push that reached the push fan-out since this daemon started. */
  readonly lastMade?: NotificationAttempt;
}

const NAME = 'notifications';
const SILENT = 'The phone stays silent for stops, deadlines and pings while this lasts.';

const row = (status: DoctorCheck['status'], summary: string, impact: string): DoctorCheck => ({
  name: NAME,
  requirement: 'capability',
  status,
  summary,
  impact,
});

const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? '' : 's'}`;

/**
 * WHETHER THIS DAEMON CAN BUZZ A PHONE, as `fy doctor` rows.
 *
 * WHY THIS EXISTS. From v4.116.0 a ledger line the daemon could no longer read made every push fail,
 * the failure was swallowed, and for days nothing said so: the owner only noticed the silence. A push
 * that cannot be made now fails this row; it does not wait for somebody to miss a buzz.
 *
 * What is said, worst first: a ledger that cannot be read, a push that failed more recently than one was
 * made, no device enrolled, and a newest recorded push that errored or reached none of its devices.
 * Skipped ledger lines are a separate note: pushes still go out. Pure.
 */
export function notificationHealthChecks(reading: NotificationHealthReading): readonly DoctorCheck[] {
  return [mainRow(reading), ...skippedRow(reading.ledger)];
}

function mainRow(reading: NotificationHealthReading): DoctorCheck {
  const { ledger, lastFailed, lastMade, enrolled } = reading;
  if (!ledger.readable)
    return row(
      'missing',
      `notifications.jsonl cannot be read: ${ledger.reason}`,
      `No push is made until the daemon can read its notification ledger. ${SILENT}`,
    );
  if (lastFailed !== undefined && (lastMade === undefined || lastFailed.at > lastMade.at))
    return row(
      'missing',
      `the newest push failed at ${lastFailed.at}: ${lastFailed.reason}`,
      `${SILENT} The daemon log has a "notifications:" line for every push that failed.`,
    );
  if (enrolled === 0)
    return row(
      'missing',
      'no device is enrolled for push',
      'Nothing buzzes. Turn notifications on in the app: Settings → Notifications.',
    );
  const latest = ledger.latestOutcome;
  if (latest?.error !== undefined)
    return row('missing', `the newest recorded push failed at ${latest.at}: ${latest.error}`, SILENT);
  if (latest !== undefined && latest.delivered === 0 && latest.failed > 0)
    return row(
      'missing',
      `the newest recorded push, at ${latest.at}, reached none of its ${plural(latest.failed, 'device')}`,
      'A device that refuses pushes needs enrolling again: Settings → Notifications on that device.',
    );
  return row(
    'present',
    latest === undefined
      ? `${plural(enrolled, 'device')} enrolled; no push recorded yet`
      : `${plural(enrolled, 'device')} enrolled; the newest push reached ${latest.delivered} at ${latest.at}`,
    'The phone buzzes when a ferret stops on you, a deadline nears, or a notice pings.',
  );
}

function skippedRow(ledger: NotificationLedgerHealth): readonly DoctorCheck[] {
  if (!ledger.readable || ledger.skipped === 0) return [];
  return [
    {
      name: 'notification log',
      requirement: 'optional',
      status: 'missing',
      summary: `${plural(ledger.skipped, 'unreadable line')} in notifications.jsonl skipped`,
      impact:
        'Pushes still go out. A stop, item or notice a skipped line recorded may buzz once more; the daemon log names the first line.',
    },
  ];
}
