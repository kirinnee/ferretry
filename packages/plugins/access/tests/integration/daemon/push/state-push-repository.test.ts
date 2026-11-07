import { describe, it } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { PushFile } from '../../../../contract/index.ts';
import { StatePushRepository } from '../../../../daemon/adapters/push/index.ts';
import type { PushSubscriptionRecord } from '../../../../daemon/lib/push/index.ts';
import type { BrowserPushSubscription } from '../../../../daemon/lib/wire.ts';
import { refused } from './support.ts';

const AT = '2026-08-05T09:00:00.000Z';
const deviceId = (marker: string) => `fy_device_id_${marker.repeat(22).slice(0, 22)}`;
const pushId = (marker: string) => `push-${marker.repeat(8).slice(0, 8)}-1111-4111-8111-111111111111`;

function subscription(endpoint: string, fill = 4): BrowserPushSubscription {
  return {
    endpoint,
    expirationTime: null,
    keys: { p256dh: Buffer.alloc(65, fill).toString('base64url'), auth: Buffer.alloc(16, fill).toString('base64url') },
  };
}

function record(overrides: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
  return {
    id: pushId('a'),
    deviceId: deviceId('a'),
    deviceName: 'Pixel 8',
    subscription: subscription('https://fcm.googleapis.com/send/one'),
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

/** Access's `state/access/` held in memory, with the kernel store's rules (`format` first, damage reads as damage). */
function fixture() {
  const folder = new MemoryStateFolder();
  const state = folder.port([PushFile]);
  return { folder, state, repository: new StatePushRepository(state) };
}

describe('StatePushRepository', () => {
  it('should read an absent document as nobody enrolled and create nothing', async () => {
    const { repository, folder } = fixture();

    should(await repository.list()).be.empty();
    // A read must not bring the file into existence: a daemon nobody has enrolled with should leave no
    // trace of a capability it is not using.
    should(folder.raw(PushFile)).be.undefined();
  });

  it('should persist an enrolment owner-only and read it back exactly', async () => {
    const { repository, folder } = fixture();
    const enrolment = record();

    await repository.save(enrolment);

    should(await repository.list()).deepEqual([enrolment]);
    // The endpoint and its key halves are a capability to wake somebody's phone; the file is filed as
    // the secret it is (the kernel writes it with the mode Access declared).
    should(PushFile.mode).equal(0o600);
    should(JSON.parse(folder.raw(PushFile) ?? '{}').format).equal(1);
  });

  it('should replace an enrolment addressed by the same id rather than keeping both', async () => {
    const { repository } = fixture();
    await repository.save(record({ deviceName: 'Old name' }));

    await repository.save(record({ deviceName: 'New name', updatedAt: '2026-08-05T10:00:00.000Z' }));

    const stored = await repository.list();
    should(stored).have.length(1);
    should(stored[0]?.deviceName).equal('New name');
  });

  it('should forget a group and report how many there were to forget', async () => {
    const { repository } = fixture();
    const one = record();
    const two = record({ id: pushId('b'), subscription: subscription('https://fcm.googleapis.com/send/two', 5) });
    await repository.save(one);
    await repository.save(two);

    should(await repository.forget([one.id, pushId('z')])).equal(1);
    should((await repository.list()).map(entry => entry.id)).deepEqual([two.id]);
    // Forgetting nothing writes nothing: the empty case is the common one at the end of a sweep.
    should(await repository.forget([])).equal(0);
  });

  it('should serialize concurrent writes so neither loses the other', async () => {
    const { repository } = fixture();
    const enrolments = ['a', 'b', 'c', 'd'].map((marker, index) =>
      record({ id: pushId(marker), subscription: subscription(`https://fcm.googleapis.com/send/${index}`, index + 1) }),
    );

    // A read-modify-write of one array: without the queue each of these reads the document before any
    // of them wrote, and three of the four rows vanish.
    await Promise.all(enrolments.map(async enrolment => await repository.save(enrolment)));

    should((await repository.list()).map(entry => entry.id).sort()).deepEqual(enrolments.map(entry => entry.id).sort());
  });

  it('should keep serving after one write fails', async () => {
    const { state } = fixture();
    let failNext = true;
    const failing: StatePort = {
      ...state,
      update: ((file, fn, name) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('the disk is full'));
        }
        return state.update(file, fn, name);
      }) as StatePort['update'],
    };
    const repository = new StatePushRepository(failing);

    await repository.save(record()).should.be.rejectedWith(/disk is full/u);
    // The queue must not be poisoned by a rejection: one failed write cannot end this daemon's ability
    // to enrol anything for the rest of its life.
    await repository.save(record());
    should(await repository.list()).have.length(1);
  });

  it('should refuse a document it cannot read rather than reporting an empty fleet', async () => {
    const damaged = fixture();
    damaged.folder.plant(PushFile, '{');
    const wrongShape = fixture();
    wrongShape.folder.plant(PushFile, JSON.stringify({ format: 2, subscriptions: [] }));
    const duplicated = fixture();
    duplicated.folder.plant(PushFile, JSON.stringify({ format: 1, subscriptions: [record(), record()] }));
    // A row carrying a field the record does not declare is damage too: the record is strict, with no exception.
    const unknownField = fixture();
    unknownField.folder.plant(
      PushFile,
      JSON.stringify({ format: 1, subscriptions: [{ ...record(), prefs: { events: { attention: true } } }] }),
    );

    // The benign reading is the dangerous one: it answers every list with nobody enrolled, drops every
    // notification, and looks exactly like a machine with nothing to say.
    should((await refused(damaged.repository.list())).code).equal('corrupt_store');
    should((await refused(wrongShape.repository.list())).code).equal('corrupt_store');
    should((await refused(duplicated.repository.list())).code).equal('corrupt_store');
    should((await refused(unknownField.repository.list())).code).equal('corrupt_store');
  });

  it('should refuse to persist an enrolment the wire could not describe', async () => {
    const { repository } = fixture();

    await repository.save(record({ deviceId: 'not-a-device-id' })).should.be.rejected();
    should(await repository.list()).be.empty();
  });
});
