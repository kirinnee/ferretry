import { describe, it } from 'bun:test';
import type { RegisterPushDeviceRequest } from '@ferretry/protocol';
import should from 'should';
import {
  PairedPushDevices,
  PushService,
  type PushDelivery,
  type PushDeliveryOutcome,
  type PushSubscriptionRecord,
  type PushSubscriptionStore,
} from '../../../src/lib/push/index.ts';
import { AT, allEvents, deviceId, LATER, record, refused, subscription } from './support.ts';

/** An enrolment store held in a field. The projection, the sweep and the lifetime rules are all real. */
class FakeStore implements PushSubscriptionStore {
  readonly forgotten: string[][] = [];

  constructor(public records: readonly PushSubscriptionRecord[] = []) {}

  async list(): Promise<readonly PushSubscriptionRecord[]> {
    return this.records;
  }

  async save(record: PushSubscriptionRecord): Promise<void> {
    this.records = [...this.records.filter(existing => existing.id !== record.id), record];
  }

  async forget(ids: readonly string[]): Promise<number> {
    this.forgotten.push([...ids]);
    const kept = this.records.filter(existing => !ids.includes(existing.id));
    const removed = this.records.length - kept.length;
    this.records = kept;
    return removed;
  }
}

/** A transport that records what it was asked to deliver and answers whatever it was told to. */
class FakeTransport {
  readonly sent: PushDelivery[] = [];

  constructor(private readonly outcomes: readonly PushDeliveryOutcome[] = ['delivered']) {}

  async deliver(delivery: PushDelivery): Promise<PushDeliveryOutcome> {
    this.sent.push(delivery);
    return this.outcomes[this.sent.length - 1] ?? this.outcomes.at(-1) ?? 'delivered';
  }
}

interface World {
  readonly store: FakeStore;
  readonly transport: FakeTransport;
  readonly service: PushService;
}

function world(
  options: {
    readonly records?: readonly PushSubscriptionRecord[];
    readonly granted?: readonly string[];
    readonly outcomes?: readonly PushDeliveryOutcome[];
    readonly now?: string;
  } = {},
): World {
  const store = new FakeStore(options.records ?? []);
  const transport = new FakeTransport(options.outcomes);
  const service = new PushService({
    store,
    transport,
    keys: { publicKey: async () => 'the-public-point' },
    devices: { granted: async () => new Set(options.granted ?? [deviceId('a')]) },
    clock: { now: () => options.now ?? LATER },
    ids: { next: () => '22222222-2222-4222-8222-222222222222' },
  });
  return { store, transport, service };
}

const registration = (endpoint: string, deviceName = 'Pixel 8'): RegisterPushDeviceRequest => ({
  deviceName,
  subscription: subscription(endpoint),
  prefs: allEvents,
});

describe('PairedPushDevices', () => {
  it('should read the grants from the store that owns them', async () => {
    const directory = new PairedPushDevices({
      list: async () => [
        {
          id: deviceId('a'),
          daemonId: 'fy_daemon_x',
          name: 'Pixel 8',
          platform: 'browser' as const,
          createdAt: AT,
          lastSeenAt: AT,
          tokenHash: 'h',
        },
      ],
    });

    should([...(await directory.granted())]).eql([deviceId('a')]);
  });
});

describe('PushService.publicKey', () => {
  it('should answer with the application-server key and nothing else', async () => {
    should(await world().service.publicKey()).equal('the-public-point');
  });
});

describe('PushService.register', () => {
  it('should enrol a browser against the device that asked, and confirm it by using it', async () => {
    const { service, store, transport } = world();

    const view = await service.register(deviceId('a'), registration('https://push.example.test/send/one'));

    should(view.id).equal('push-22222222-2222-4222-8222-222222222222');
    should(view.deviceName).equal('Pixel 8');
    should(store.records).have.length(1);
    should(store.records[0]?.deviceId).equal(deviceId('a'));
    // The endpoint was USED once, not merely stored: an enrolment reported as working must have been
    // accepted by the push service that owns the endpoint.
    should(transport.sent).have.length(1);
    should(JSON.parse(transport.sent[0]?.payload ?? '{}')).match({ title: 'Notifications are on' });
  });

  it('should replace an earlier enrolment of the same endpoint rather than minting a second', async () => {
    const existing = record({ deviceName: 'Old name' });
    const { service, store } = world({ records: [existing] });

    const view = await service.register(deviceId('a'), registration(existing.subscription.endpoint, 'New name'));

    should(store.records).have.length(1);
    // The id the client remembers and the instant it first enrolled both survive; the name and the
    // update stamp move. Two rows for one endpoint would deliver every notification twice.
    should(view.id).equal(existing.id);
    should(view.createdAt).equal(AT);
    should(view.updatedAt).equal(LATER);
    should(view.deviceName).equal('New name');
  });

  it('should refuse and forget an endpoint the push service has already discarded', async () => {
    const { service, store } = world({ outcomes: ['expired'] });

    const refusal = await refused(service.register(deviceId('a'), registration('https://push.example.test/send/gone')));
    should(refusal.code).equal('invalid');
    should(store.records).be.empty();
  });

  it('should keep an enrolment whose confirmation merely failed to get through', async () => {
    const { service, store } = world({ outcomes: ['failed'] });

    const view = await service.register(deviceId('a'), registration('https://push.example.test/send/one'));

    // A timeout or a 5xx says something about the network, not about the browser. Deleting the
    // enrolment over one would cost somebody their notifications for a transient fault.
    should(store.records).have.length(1);
    should(store.records[0]?.id).equal(view.id);
  });

  it('should refuse a registration the wire could not describe before it is persisted', async () => {
    const { service, store } = world();

    await service.register('not-a-device-id', registration('https://push.example.test/send/one')).should.be.rejected();
    should(store.records).be.empty();
  });
});

describe('PushService.list', () => {
  it('should answer with the enrolments of devices that still have a grant', async () => {
    const mine = record();
    const theirs = record({ id: 'push-33333333-3333-4333-8333-333333333333', deviceId: deviceId('b') });
    const { service, store } = world({ records: [mine, theirs], granted: [deviceId('a')] });

    const devices = await service.list();

    should(devices.map(device => device.id)).eql([mine.id]);
    // The orphan is not merely hidden — it is swept, so nothing later can find it either.
    should(store.forgotten).eql([[theirs.id]]);
    should(store.records.map(entry => entry.id)).eql([mine.id]);
  });

  it('should sweep nothing when every enrolment still belongs to a device', async () => {
    const { service, store } = world({ records: [record()] });

    should(await service.list()).have.length(1);
    should(store.forgotten).be.empty();
  });
});

describe('PushService.revoke', () => {
  it('should answer with the enrolment it ended', async () => {
    const enrolment = record();
    const { service, store } = world({ records: [enrolment] });

    const view = await service.revoke(enrolment.id);

    should(view.id).equal(enrolment.id);
    should(store.records).be.empty();
  });

  it('should refuse an id nobody is enrolled under', async () => {
    const { service } = world({ records: [record()] });

    should((await refused(service.revoke('push-99999999-9999-4999-8999-999999999999'))).code).equal('not_found');
  });

  it('should refuse an enrolment whose device no longer has a grant', async () => {
    const orphan = record({ deviceId: deviceId('b') });
    const { service } = world({ records: [orphan], granted: [deviceId('a')] });

    // "Revoked" and "there was nothing here" are different answers, and an orphan is the second one:
    // the enrolment is already unreachable, so reporting a successful revocation would be a fiction.
    should((await refused(service.revoke(orphan.id))).code).equal('not_found');
  });
});

describe('PushService.forgetDevice', () => {
  it('should forget every enrolment one device made, and count them', async () => {
    const one = record();
    const two = record({
      id: 'push-44444444-4444-4444-8444-444444444444',
      subscription: subscription('https://push.example.test/send/two', 5),
    });
    const other = record({ id: 'push-55555555-5555-4555-8555-555555555555', deviceId: deviceId('b') });
    const { service, store } = world({ records: [one, two, other] });

    should(await service.forgetDevice(deviceId('a'))).equal(2);
    should(store.records.map(entry => entry.id)).eql([other.id]);
  });

  it('should read the store raw, so it works on either side of the grant being removed', async () => {
    const orphan = record({ deviceId: deviceId('b') });
    const { service, store } = world({ records: [orphan], granted: [deviceId('a')] });

    should(await service.forgetDevice(deviceId('b'))).equal(1);
    should(store.records).be.empty();
  });

  it('should not be an error to purge a device that held no enrolment', async () => {
    const { service, store } = world({ records: [record()] });

    // Two people revoking the same lost phone is the expected way this is used.
    should(await service.forgetDevice(deviceId('z'))).equal(0);
    should(store.records).have.length(1);
  });
});

describe('PushService.notify', () => {
  const attention = {
    version: 1 as const,
    eventKey: 'e1',
    title: 'A session needs you',
    body: 'Answer the question',
    tag: 't1',
    url: '/',
    count: 1,
    sessionId: 's1',
    kind: 'attention' as const,
  };

  it('should tell every enrolled device and report what got through', async () => {
    const one = record();
    const two = record({ id: 'push-66666666-6666-4666-8666-666666666666' });
    const { service, transport } = world({ records: [one, two], outcomes: ['delivered', 'failed'] });

    should(await service.notify({ payload: attention })).eql({ delivered: 1, failed: 1 });
    should(transport.sent).have.length(2);
    should(JSON.parse(transport.sent[0]?.payload ?? '{}')).match({ sessionId: 's1' });
  });

  it('should address only the enrolments it was asked to', async () => {
    const one = record();
    const two = record({ id: 'push-77777777-7777-4777-8777-777777777777' });
    const { service, transport } = world({ records: [one, two] });

    should(await service.notify({ payload: attention }, [two.id])).eql({ delivered: 1, failed: 0 });
    should(transport.sent.map(sent => sent.subscription.endpoint)).eql([two.subscription.endpoint]);
  });

  it('should count a device that declined in neither total, because it was never asked', async () => {
    const declining = record({ prefs: { events: { ...allEvents.events, attention: false }, interactiveOnly: false } });
    const { service, transport } = world({ records: [declining] });

    should(await service.notify({ payload: attention })).eql({ delivered: 0, failed: 0 });
    should(transport.sent).be.empty();
  });

  it('should forget an endpoint the push service reports as gone', async () => {
    const alive = record();
    const dead = record({ id: 'push-88888888-8888-4888-8888-888888888888' });
    const { service, store } = world({ records: [alive, dead], outcomes: ['delivered', 'expired'] });

    should(await service.notify({ payload: attention })).eql({ delivered: 1, failed: 1 });
    // This is the only place in the daemon that can learn a browser is unreachable, so it is the only
    // place that may act on it.
    should(store.records.map(entry => entry.id)).eql([alive.id]);
  });

  it('should tell nobody when nobody is enrolled', async () => {
    const { service, store } = world();

    should(await service.notify({ payload: attention })).eql({ delivered: 0, failed: 0 });
    should(store.forgotten).be.empty();
  });
});
