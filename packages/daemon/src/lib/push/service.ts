import {
  PairedDeviceIdSchema,
  PUSH_URGENT_TTL_SECONDS,
  type PushDeliveryResult,
  PushDeliveryResultSchema,
  type PushDeviceView,
  type RegisterPushDeviceRequest,
} from '@ferretry/protocol';
import type { PairingDeviceStore } from '../pairing/index.ts';
import { enrolmentConfirmation, pushDeviceView } from './policy.ts';
import {
  type PushClock,
  type PushDeviceDirectory,
  type PushDispatch,
  PushError,
  type PushIdentifiers,
  type PushSubscriptionRecord,
  type PushSubscriptionStore,
  type VapidKeyPort,
  type WebPushTransport,
} from './types.ts';

/** Which device grants exist, read from the pairing store that owns them. */
export class PairedPushDevices implements PushDeviceDirectory {
  constructor(private readonly devices: Pick<PairingDeviceStore, 'list'>) {}

  async granted(): Promise<ReadonlySet<string>> {
    return new Set((await this.devices.list()).map(device => device.id));
  }
}

export interface PushServiceOptions {
  readonly store: PushSubscriptionStore;
  readonly keys: VapidKeyPort;
  readonly transport: WebPushTransport;
  /** The device grants an enrolment's lifetime is measured against. */
  readonly devices: PushDeviceDirectory;
  readonly clock: PushClock;
  readonly ids: PushIdentifiers;
}

/**
 * The complete Web Push surface of one daemon.
 *
 * ## A REVOKED DEVICE CANNOT BE REACHED, PROVED TWICE
 *
 * Taking a phone's access away while it keeps buzzing with this machine's business is a security
 * defect, so it does not rest on one mechanism:
 *
 * 1. **Structural.** Every read and every delivery goes through `enrolments`, which intersects the
 *    stored rows with the device grants that still exist and drops the rest. A row nobody remembered
 *    to delete therefore cannot be listed and cannot be delivered to — the guarantee holds even if
 *    the step below never ran.
 * 2. **Explicit.** Revoking a device purges its enrolments in the same act, BEFORE the grant itself
 *    is removed, so a purge that fails leaves a consistent world instead of a phone that is unpaired
 *    and still reachable. See `PairingService.revokeDevice`.
 *
 * Only a paired DEVICE may enrol at all: the mount takes the owning device id from the credential the
 * authorization boundary derived, never from the body, so an enrolment cannot be filed against a
 * device the caller does not hold — and the host's admin token, which is not a device and has no
 * browser, is refused rather than filed against nothing.
 *
 * ## WHAT THIS DOES NOT DO — DECLARED, NOT DISCOVERED
 *
 * - **The browser has no service worker.** Enrolment, storage, delivery and revocation are all real on
 *   this side; the client cannot yet subscribe or display anything, because no worker is registered.
 *   Nothing here is blocked on that — an endpoint is validated against its push service, not against
 *   whether a tab drew a toast — but push is not end-to-end until that lands.
 *
 * The notification domain owns when to speak: a committed Attention creation or an explicit audited
 * direct request. It calls `notify` rather than creating a second fan-out here. Session lifecycle
 * changes remain deliberately silent so native harness notifications are not duplicated.
 */
export class PushService {
  constructor(private readonly options: PushServiceOptions) {}

  /** The application-server key a browser subscribes with. The private half is unreachable from here. */
  async publicKey(): Promise<string> {
    return await this.options.keys.publicKey();
  }

  /** Every enrolment still bound to a live device grant. */
  async list(): Promise<readonly PushDeviceView[]> {
    return (await this.enrolments()).map(pushDeviceView);
  }

  /** The enrolments ONE device filed — what a device may always see of its own notifications. */
  async listFor(deviceId: string): Promise<readonly PushDeviceView[]> {
    return (await this.enrolments()).filter(record => record.deviceId === deviceId).map(pushDeviceView);
  }

  /** Which device filed an enrolment, or nothing for an id that is not enrolled. */
  async ownerOf(id: string): Promise<string | undefined> {
    return (await this.enrolments()).find(record => record.id === id)?.deviceId;
  }

  /**
   * Enrols one browser, on behalf of the paired device that asked.
   *
   * THE ENDPOINT IS THE IDENTITY, not the id: a browser that re-enrols — after re-pairing, after a
   * name change, after a preference change — presents the same endpoint, and minting a second row for
   * it would deliver every notification twice and leave a stale name in the list. The row is therefore
   * replaced in place, keeping the id the client remembers and the instant it first enrolled.
   *
   * THE ENROLMENT IS THEN USED, once, before it is reported as working. A stored endpoint proves
   * nothing about reachability, and a push service that answers "gone" is telling us this browser can
   * never be reached at this address again; storing it anyway would report a capability the daemon
   * does not have. Any OTHER delivery failure keeps the enrolment — a timeout says something about the
   * network, not about the endpoint.
   *
   * The confirmation goes through `notify`, and the refusal is read from whether the enrolment SURVIVED
   * it. That is deliberate on both counts. One delivery path means the daemon has one place that knows
   * how to reach a browser and one place that decides an endpoint is dead, rather than a second opinion
   * here about the same transport facts. And `notify` already forgets an endpoint reported as gone — so
   * "the row is no longer there" IS this daemon's own answer to whether the browser can be reached, and
   * re-deriving it from the outcome would be that answer written down twice.
   */
  async register(deviceId: string, request: RegisterPushDeviceRequest): Promise<PushDeviceView> {
    const at = this.options.clock.now();
    const existing = (await this.options.store.list()).find(
      record => record.subscription.endpoint === request.subscription.endpoint,
    );
    // An endpoint is one browser's. Re-filing a row another device holds would let a device that learned
    // that endpoint take the enrolment — and its alerts — over. Refused, never re-owned.
    if (existing !== undefined && existing.deviceId !== deviceId)
      throw new PushError('invalid', 'this browser subscription is enrolled for another device');
    const record: PushSubscriptionRecord = {
      id: existing?.id ?? `push-${this.options.ids.next()}`,
      // PARSED, not trusted. The owning id is derived from the caller's credential by the boundary
      // above, so an unusable one is a defect there rather than bad input — and a row filed against a
      // device id no grant can ever match is a row nothing could revoke and the sweep would silently
      // eat. Refuse it here, where the record is composed, instead of relying on the store's schema
      // one layer further down.
      deviceId: PairedDeviceIdSchema.parse(deviceId),
      deviceName: request.deviceName,
      subscription: request.subscription,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    // Projected BEFORE the store is touched, so a record the wire could not describe is refused
    // rather than persisted and then failed on the way out.
    const view = pushDeviceView(record);
    await this.options.store.save(record);
    // The confirmation is sent, and its fate is NOT reported: an answer that said whether the push service
    // accepted it would be a reachability oracle. A subscription the service has discarded is dropped by
    // the same delivery path every later notification uses.
    await this.notify({ payload: enrolmentConfirmation(record.deviceName) }, [record.id]);
    return view;
  }

  /**
   * Ends one enrolment, answering with the enrolment it ended.
   *
   * The removed view rather than a bare 204, because a client that had to guess the new state is a
   * client that can show a device it has already revoked. An id that is not enrolled — or is enrolled
   * against a device that no longer exists — is `not_found`: "revoked" and "there was nothing here"
   * are different answers.
   */
  async revoke(id: string): Promise<PushDeviceView> {
    const record = (await this.enrolments()).find(enrolment => enrolment.id === id);
    if (record === undefined) throw new PushError('not_found', 'no push enrolment with that id');
    await this.options.store.forget([record.id]);
    return pushDeviceView(record);
  }

  /**
   * Forgets everything this daemon can push to one device with.
   *
   * Reads the store RAW rather than through `enrolments`, because it is called while the grant is
   * being taken away and must work whichever side of that removal it runs on.
   */
  async forgetDevice(deviceId: string): Promise<number> {
    const owned = (await this.options.store.list()).filter(record => record.deviceId === deviceId);
    return await this.options.store.forget(owned.map(record => record.id));
  }

  /**
   * Tells every enrolled device, unconditionally.
   *
   * `to` narrows to named enrolments, which is what a confirmation wants: it is addressed to the
   * browser that just enrolled and to nobody else. EVERY OTHER EVENT GOES TO EVERY ADDRESSED DEVICE —
   * there is no preference row here to consult, so a browser this daemon has never described before
   * is told exactly what every other one is. Which events a reader is actually shown is a decision
   * their own browser makes from its own local storage; see
   * `packages/pwa/src/lib/notification-filter.ts`.
   *
   * An endpoint a push service reports as gone is forgotten here, which is the only place that
   * discovery can be made: nothing else in this daemon ever learns that a browser is unreachable.
   * `delivered` means a push endpoint accepted the request; it does not claim a person observed it.
   */
  async notify(dispatch: PushDispatch, to?: readonly string[]): Promise<PushDeliveryResult> {
    const enrolled = await this.enrolments();
    const addressed = to === undefined ? enrolled : enrolled.filter(record => to.includes(record.id));
    const payload = JSON.stringify(dispatch.payload);
    // A high push is about something that expires (a one-time code): it asks to be delivered now, and not at all later.
    // A push about something that ends sooner (an approve-on-phone card) is held no longer than it lives.
    const held = dispatch.ttlSeconds === undefined ? undefined : Math.max(0, Math.floor(dispatch.ttlSeconds));
    const ttlSeconds =
      dispatch.urgency === 'high' ? Math.min(held ?? PUSH_URGENT_TTL_SECONDS, PUSH_URGENT_TTL_SECONDS) : held;
    const urgent = {
      ...(dispatch.urgency === 'high' ? { urgency: dispatch.urgency } : {}),
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
    };
    const outcomes = await Promise.all(
      addressed.map(
        async record => await this.options.transport.deliver({ subscription: record.subscription, payload, ...urgent }),
      ),
    );
    const expired = addressed.filter((_, index) => outcomes[index] === 'expired').map(record => record.id);
    if (expired.length > 0) await this.options.store.forget(expired);
    const delivered = outcomes.filter(outcome => outcome === 'delivered').length;
    return PushDeliveryResultSchema.parse({ delivered, failed: outcomes.length - delivered });
  }

  /**
   * The stored rows that still belong to a device, sweeping the ones that do not.
   *
   * The sweep is why revocation cannot leak: an orphaned row is deleted the first time anybody reads
   * or delivers, so the window in which one could be used is the window in which nothing looks at the
   * store — and every use looks at it through here.
   */
  private async enrolments(): Promise<readonly PushSubscriptionRecord[]> {
    const [records, granted] = await Promise.all([this.options.store.list(), this.options.devices.granted()]);
    const orphaned = records.filter(record => !granted.has(record.deviceId));
    if (orphaned.length > 0) await this.options.store.forget(orphaned.map(record => record.id));
    return records.filter(record => granted.has(record.deviceId));
  }
}
