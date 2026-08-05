import {
  PairedDeviceIdSchema,
  type PushDeliveryResult,
  PushDeliveryResultSchema,
  type PushDeviceView,
  type RegisterPushDeviceRequest,
} from '@ferretry/protocol';
import type { PairingDeviceStore } from '../pairing/index.ts';
import { acceptsDispatch, enrolmentConfirmation, pushDeviceView } from './policy.ts';
import {
  PushError,
  type PushClock,
  type PushDeviceDirectory,
  type PushDispatch,
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
 * - **Nothing raises a notification yet.** `notify` is reachable, exercised and correct, but the only
 *   production caller is `register`'s own enrolment confirmation. A durable attention item, a session
 *   that failed and the agent-callable direct notification each need a presenter that decides WHEN to
 *   speak, and that decision is owned by the notification unit rather than smuggled in here — a
 *   status watcher wired up as a substitute would duplicate the harnesses' own notifications.
 * - **The browser has no service worker.** Enrolment, storage, delivery and revocation are all real on
 *   this side; the client cannot yet subscribe or display anything, because no worker is registered.
 *   Nothing here is blocked on that — an endpoint is validated against its push service, not against
 *   whether a tab drew a toast — but push is not end-to-end until that lands.
 * - **`interactive` has no production source.** The preference is stored, honoured and tested, and the
 *   only caller today sends a payload about no session, for which it does not apply.
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
   */
  async register(deviceId: string, request: RegisterPushDeviceRequest): Promise<PushDeviceView> {
    const at = this.options.clock.now();
    const existing = (await this.options.store.list()).find(
      record => record.subscription.endpoint === request.subscription.endpoint,
    );
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
      prefs: request.prefs,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    // Projected BEFORE the store is touched, so a record the wire could not describe is refused
    // rather than persisted and then failed on the way out.
    const view = pushDeviceView(record);
    await this.options.store.save(record);
    const outcome = await this.options.transport.deliver({
      subscription: record.subscription,
      payload: JSON.stringify(enrolmentConfirmation(record.deviceName)),
    });
    if (outcome === 'expired') {
      await this.options.store.forget([record.id]);
      throw new PushError('invalid', 'the push service has already discarded this subscription');
    }
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
   * Tells every device that agreed to hear it.
   *
   * `to` narrows to named enrolments, which is what a confirmation wants: it is addressed to the
   * browser that just enrolled and to nobody else. Devices whose preferences decline the notification
   * are counted in NEITHER total — they were not asked, so reporting them as failures would make a
   * reader's own choice look like a fault.
   *
   * An endpoint a push service reports as gone is forgotten here, which is the only place that
   * discovery can be made: nothing else in this daemon ever learns that a browser is unreachable.
   */
  async notify(dispatch: PushDispatch, to?: readonly string[]): Promise<PushDeliveryResult> {
    const enrolled = await this.enrolments();
    const addressed = to === undefined ? enrolled : enrolled.filter(record => to.includes(record.id));
    const chosen = addressed.filter(record => acceptsDispatch(record.prefs, dispatch));
    const payload = JSON.stringify(dispatch.payload);
    const outcomes = await Promise.all(
      chosen.map(async record => await this.options.transport.deliver({ subscription: record.subscription, payload })),
    );
    const expired = chosen.filter((_, index) => outcomes[index] === 'expired').map(record => record.id);
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
