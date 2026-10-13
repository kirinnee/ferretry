import type { PushDeliveryResult, PushDeviceView } from '@ferretry/protocol';
import type { PushDispatch } from '../push/types.ts';
import { auditRecord, newDeviceAlert } from './policy.ts';
import type {
  AuditClock,
  AuditEntry,
  AuditFailureReporter,
  AuditJournalPort,
  AuditReading,
  AuditSink,
  NewDeviceAlertPort,
  PairedDeviceNotice,
} from './types.ts';

export interface AuditLogOptions {
  readonly journal: AuditJournalPort;
  readonly clock: AuditClock;
  readonly failures: AuditFailureReporter;
}

/**
 * The one writer and reader of this daemon's security log.
 *
 * ## A RECORD THAT CANNOT BE WRITTEN IS SAID OUT LOUD, NEVER THROWN
 *
 * Every record describes something that has ALREADY happened — a device is paired, a phone is
 * revoked. Throwing a failed write back into that request would report a revocation that worked as
 * one that did not, and a person would try again against a phone that is already gone. So `record`
 * resolves either way, and a failure goes to the operator through {@link AuditFailureReporter}:
 * the log is incomplete, and the person who owns the machine is told so, which is the opposite of
 * the silent hole an unreported failure would leave.
 *
 * A record that does not fit the contract is the same kind of failure — an emitter bug — and is
 * reported the same way rather than written as a line the reader would have to count as damage.
 */
export class AuditLog implements AuditSink {
  constructor(private readonly options: AuditLogOptions) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      const line = JSON.stringify(auditRecord(entry, this.options.clock.now()));
      await this.options.journal.append(line);
    } catch (error) {
      this.options.failures.auditWriteFailed(
        `the security log could not record a ${entry.event} event, so it has a gap: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The most recent records, newest first, with the count of lines that could not be read. */
  async recent(limit: number): Promise<AuditReading> {
    return await this.options.journal.recent(limit);
  }
}

/** The two things the alert needs from the push domain, and nothing that could reach a key. */
export interface NewDeviceAlertPush {
  list(): Promise<readonly PushDeviceView[]>;
  notify(dispatch: PushDispatch, to?: readonly string[]): Promise<PushDeliveryResult>;
}

/**
 * "A new device was paired" — pushed to every enrolment that already existed.
 *
 * EVERY OTHER DEVICE, BY CONSTRUCTION. An enrolment is filed against a device grant, and the device
 * that was just paired has not enrolled yet — it cannot have: its grant is seconds old and enrolling
 * takes the browser's own permission prompt. The enrolments listed here are therefore exactly the
 * devices that were paired BEFORE it, and the addressed list is taken before anything is sent so a
 * concurrent enrolment cannot slip in.
 *
 * A DELIVERY THAT FAILS DOES NOT UNDO THE PAIRING. The alert is a warning about something that has
 * already happened; the app's own in-app notice is the second channel that carries the same news.
 */
export class PushNewDeviceAlert implements NewDeviceAlertPort {
  constructor(
    private readonly push: NewDeviceAlertPush,
    private readonly machineName: string,
    private readonly failures: AuditFailureReporter,
  ) {}

  async newDevicePaired(device: PairedDeviceNotice): Promise<void> {
    try {
      const addressed = (await this.push.list()).map(enrolment => enrolment.id);
      if (addressed.length === 0) return;
      await this.push.notify({ payload: newDeviceAlert(device, this.machineName) }, addressed);
    } catch (error) {
      this.failures.auditWriteFailed(
        `the other devices could not be told that ${device.deviceName} was paired: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
