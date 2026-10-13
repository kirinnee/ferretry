import type { AuditActor, AuditDetail, AuditEvent, AuditOutcome, AuditRecord } from '@ferretry/protocol';

/**
 * THE SECURITY AUDIT LOG, AND WHY EVERY EMITTER TALKS TO A PORT.
 *
 * The log answers "who could reach this machine, and what did they do with it" after the fact. The
 * things worth recording happen all over the daemon — pairing, grants, the fleet, terminals, secrets
 * — and each of those owners is somebody else's file. So nothing here reaches into them: each site
 * makes ONE call on {@link AuditSink}, handed to it at the composition root, and this domain owns
 * the record's shape, the bound on the file, and the read.
 *
 * AN AUDIT WRITE NEVER DECIDES AN OUTCOME. A record is written AFTER the thing it describes, and a
 * write that fails is reported to the operator rather than thrown into the request: refusing to
 * revoke a stolen phone because a disk was full would be the security log making the machine less
 * safe. See `AuditLog.record`.
 */

/** One thing that happened, as an emitter describes it. The instant is this domain's to stamp. */
export interface AuditEntry {
  readonly event: AuditEvent;
  readonly actor: AuditActor;
  readonly subject?: string;
  readonly outcome: AuditOutcome;
  readonly detail?: AuditDetail;
}

/** Where emitters write. One method, so a site's whole involvement is one line. */
export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}

/** What one bounded read found: the records it could parse, and a count of the lines it could not. */
export interface AuditReading {
  /** Newest first. */
  readonly records: readonly AuditRecord[];
  readonly unreadable: number;
}

/**
 * Which of the two stores a line goes to.
 *
 * `kept` holds the successes a reader must never lose — a pairing, a revocation, a grant change — and
 * nothing else; `general` holds everything else, refusals included. Each is bounded on its own, so a
 * flood fills `general` and cannot rotate a single `kept` line away.
 */
export type AuditStore = 'kept' | 'general';

/**
 * The two bounded append-only stores.
 *
 * `append` is ONE write of ONE line into one store — the adapter rotates that store beforehand when
 * the line would carry it past its bound. `recent` reads both stores, newest first by instant, and
 * counts what it cannot parse.
 */
export interface AuditJournalPort {
  append(line: string, store: AuditStore): Promise<void>;
  recent(limit: number): Promise<AuditReading>;
}

export interface AuditClock {
  now(): string;
}

/** Where a failed audit write is said out loud, since it may not be thrown into the request. */
export interface AuditFailureReporter {
  auditWriteFailed(message: string): void;
}

/**
 * A device that was just paired, as the alert needs to name it.
 *
 * Its own small shape rather than the pairing record, so the alert cannot be handed — and so cannot
 * forward — the token digest that record carries.
 */
export interface PairedDeviceNotice {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly carrier: 'direct' | 'relay';
  /** The daemon's instant, never a browser's. */
  readonly createdAt: string;
}

/**
 * Tells every OTHER enrolled device that a new one was paired.
 *
 * A port so the audit domain does not import the push domain's transport: the composition root hands
 * the push service in, and the alert decides only who is told and what they read.
 */
export interface NewDeviceAlertPort {
  newDevicePaired(device: PairedDeviceNotice): Promise<void>;
}
