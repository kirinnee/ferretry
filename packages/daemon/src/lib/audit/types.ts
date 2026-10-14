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

/**
 * What one bounded read found: the recent activity, a page of the kept records, how many kept records
 * there are in all, and a count of the lines it could not parse.
 */
export interface AuditReading {
  /** The general store, newest first. */
  readonly records: readonly AuditRecord[];
  /** The kept store, newest first, from the requested offset. */
  readonly kept: readonly AuditRecord[];
  readonly keptTotal: number;
  readonly unreadable: number;
}

/**
 * Which of the two stores a line goes to.
 *
 * `kept` holds the successes a reader must never lose — a pairing, a revocation, a grant change — and
 * nothing else; `general` holds everything else, refusals and activity included. Each is bounded on
 * its own, so a flood fills `general` and cannot rotate a single `kept` line away.
 */
export type AuditStore = 'kept' | 'general';

/**
 * Whether an append may rotate its store to make room.
 *
 * `never` is how a paired device's record is written to the kept store: a full store REFUSES it
 * rather than renaming its oldest file away, so nothing a device does can ever push a kept record —
 * its own pairing included — off the disk. Only this machine's own records rotate the kept store.
 */
export type AuditRotation = 'rotate' | 'never';

/**
 * The two bounded append-only stores.
 *
 * `append` is ONE write of ONE line into one store — the adapter rotates that store beforehand when
 * the line would carry it past its bound. `recent` reads both stores and returns them APART — the
 * newest `limit` general records, and `limit` kept records starting `keptOffset` from the newest — so
 * no amount of activity can push a kept record off the page a reader is shown. It counts what it
 * cannot parse in either.
 */
export interface AuditJournalPort {
  /** `false` when the store was full and `rotation` was `never`, so nothing was written. */
  append(line: string, store: AuditStore, rotation?: AuditRotation): Promise<boolean>;
  recent(limit: number, keptOffset: number): Promise<AuditReading>;
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
