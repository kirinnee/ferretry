import type {
  BrowserPushSubscription,
  PushErrorCode,
  PushNotificationPayload,
  PushPreferences,
} from '@ferretry/protocol';

/**
 * WEB PUSH, AND WHY A SUBSCRIPTION IS NOT A SECOND KIND OF DEVICE.
 *
 * A browser that wants a notification while its tab is closed hands its push service an endpoint and
 * two key halves, and whoever holds that triple can make the reader's phone buzz. Two facts decide the
 * whole shape of this domain:
 *
 * 1. **The application-server key pair belongs to the DAEMON, not to a device.** It is how the push
 *    services identify who is sending, and every subscribed browser verifies the same public half. One
 *    per pairing would mean a browser could only be pushed to by the enrolment that minted it, and
 *    rotating it would silently orphan every other device.
 * 2. **A subscription belongs to ONE paired device and may not outlive it.** It is recorded against
 *    the device grant that enrolled it, so a revoked phone stops being reachable in the same act — see
 *    `PushService` for the two independent mechanisms that make that true, one of which is structural
 *    rather than a hook that has to fire.
 *
 * NOTHING HERE HOLDS THE PRIVATE HALF OF THE KEY PAIR. `VapidKeyPort` answers with the public point
 * only; signing lives behind `WebPushTransport`, which is handed a payload and a destination and
 * returns a fact. That is the same use-without-read shape the secret store has, and for the same
 * reason: a domain that could read the key is a domain that could log it.
 */

/** One enrolled browser, as this daemon records it. */
export interface PushSubscriptionRecord {
  /** `push-<uuid>`, minted here. Daemon-local, exactly like a paired device id. */
  readonly id: string;
  /** The paired device grant that enrolled it. The lifetime this record is bound to. */
  readonly deviceId: string;
  /** The reader-chosen name, shown in the enrolled-device list. */
  readonly deviceName: string;
  /** The endpoint and key halves the browser handed over. Never projected onto the wire. */
  readonly subscription: BrowserPushSubscription;
  /** What this device has agreed to be told about. */
  readonly prefs: PushPreferences;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Durable enrolments.
 *
 * `forget` takes a SET and answers a count rather than removing one id at a time, because every
 * caller above it removes a group: one revocation, one device's whole enrolment, and the sweep that
 * drops endpoints a push service has told us are gone.
 */
export interface PushSubscriptionStore {
  list(): Promise<readonly PushSubscriptionRecord[]>;
  /** Records an enrolment, replacing any earlier one with the same id. */
  save(record: PushSubscriptionRecord): Promise<void>;
  /** Forgets every named enrolment, answering how many there were to forget. */
  forget(ids: readonly string[]): Promise<number>;
}

/** This daemon's application-server identity, as the push services see it — public half only. */
export interface VapidKeyPort {
  /** The base64url uncompressed P-256 point a browser subscribes with. */
  publicKey(): Promise<string>;
}

/** Which device grants this daemon still recognises. The lifetime every enrolment is measured against. */
export interface PushDeviceDirectory {
  granted(): Promise<ReadonlySet<string>>;
}

/** One delivery, fully addressed, so the transport decides nothing about who is told what. */
export interface PushDelivery {
  readonly subscription: BrowserPushSubscription;
  /** The JSON body the service worker receives, already composed and validated. */
  readonly payload: string;
}

/**
 * What one delivery attempt did, in facts rather than conclusions.
 *
 * `expired` is the load-bearing one: a push service answering 404 or 410 is telling us this endpoint
 * will never work again, which is the only signal that a stored enrolment should be dropped. Every
 * other failure — a timeout, a 5xx, a refused connection — says nothing about the endpoint and must
 * not delete it.
 */
export type PushDeliveryOutcome = 'delivered' | 'expired' | 'failed';

/** The only outbound capability this domain has. */
export interface WebPushTransport {
  deliver(delivery: PushDelivery): Promise<PushDeliveryOutcome>;
}

/** What a delivery is about, so a device's own preferences can refuse it. */
export interface PushDispatch {
  readonly payload: PushNotificationPayload;
  /**
   * Whether the session this is about is one a human is sitting with.
   *
   * Absent for a notification about no session — a device that asked for `interactiveOnly` is
   * declining unattended session noise, not everything this daemon might ever say to it.
   */
  readonly interactive?: boolean;
}

export interface PushClock {
  now(): string;
}

export interface PushIdentifiers {
  next(): string;
}

/**
 * Every refusal this domain raises, in the taxonomy the protocol already declares.
 *
 * The codes come from `PushErrorCodeSchema` rather than from a set invented here, so the mount's HTTP
 * mapping and the client's error handling are reading one list.
 */
export class PushError extends Error {
  constructor(
    readonly code: PushErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PushError';
  }
}
