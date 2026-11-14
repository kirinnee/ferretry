import type { DoctorFinding } from '@ferretry/kernel/contract';
import type { DoctorRun } from '@ferretry/kernel/manifest';

/** The newest push this daemon made since it started, as its fan-out answered. */
interface PushOutcome {
  readonly at: string;
  readonly delivered: number;
  readonly failed: number;
}

/** What `fy doctor` reports about this daemon's pushes. */
export interface PushHealth {
  /** Devices enrolled for push now (each still bound to a live device grant). */
  readonly enrolled: number;
  readonly latest?: PushOutcome;
}

const plural = (count: number, one: string): string => `${String(count)} ${one}${count === 1 ? '' : 's'}`;

/**
 * THE `notifications` DOCTOR ROW (today's `notificationHealthChecks`, `daemon/src/lib/notifications/health.ts`): whether
 * this daemon can buzz a phone. A capability, so it is a warning and never makes the report not ready.
 *
 * What is said, worst first: no device enrolled, a newest push that reached none of its devices, else the count and the
 * newest outcome. GAP: today also read a notification ledger (`notifications.jsonl`) and named an unreadable one or a
 * line skipped; 5.0 keeps no such ledger, so the newest push is the one this run made (memory, as today's
 * `lastMade` was), and a restart forgets it.
 */
export function notificationsDoctor(read: () => Promise<PushHealth>): DoctorRun {
  return async (): Promise<DoctorFinding | undefined> => {
    let health: PushHealth;
    try {
      health = await read();
    } catch {
      return undefined;
    }
    const base = { name: 'notifications', requirement: 'capability' } as const;
    const { enrolled, latest } = health;
    if (enrolled === 0)
      return {
        ...base,
        state: 'warn',
        detail: 'no device is enrolled for push',
        fix: 'Nothing buzzes. Turn notifications on in the app: Settings → Notifications.',
      };
    if (latest !== undefined && latest.delivered === 0 && latest.failed > 0)
      return {
        ...base,
        state: 'warn',
        detail: `the newest push, at ${latest.at}, reached none of its ${plural(latest.failed, 'device')}`,
        fix: 'A device that refuses pushes needs enrolling again: Settings → Notifications on that device.',
      };
    return {
      ...base,
      state: 'ok',
      detail:
        latest === undefined
          ? `${plural(enrolled, 'device')} enrolled; no push recorded yet`
          : `${plural(enrolled, 'device')} enrolled; the newest push reached ${String(latest.delivered)} at ${latest.at}`,
      fix: 'The phone buzzes when a ferret stops on you, a deadline nears, or a notice pings.',
    };
  };
}
