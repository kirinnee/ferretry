import { afterAll, describe, it } from 'bun:test';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserPushSubscription } from '@ferretry/protocol';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { StatePushRepository } from '../../../src/adapters/push/index.ts';
import { createFoundationPaths, type PushSubscriptionRecord, resolveStateHome } from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';
import { refused } from './support.ts';

afterAll(async () => {
  await cleanupTempDirectories();
});

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
    subscription: subscription('https://push.example.test/send/one'),
    prefs: { events: { attention: true, question: true, failed: true, completed: true }, interactiveOnly: false },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

async function fixture(label: string) {
  const home = await tempDirectory(label);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  await files.ensureDirectory(paths.state, 0o700);
  return { paths, files, repository: new StatePushRepository(paths, files), document: join(paths.state, 'push.json') };
}

describe('StatePushRepository', () => {
  it('should read an absent document as nobody enrolled and create nothing', async () => {
    const { repository, document } = await fixture('push-absent');

    should(await repository.list()).be.empty();
    // A read must not bring the file into existence: a daemon nobody has enrolled with should leave no
    // trace of a capability it is not using.
    await stat(document).should.be.rejected();
  });

  it('should persist an enrolment owner-only and read it back exactly', async () => {
    const { repository, document } = await fixture('push-save');
    const enrolment = record();

    await repository.save(enrolment);

    should(await repository.list()).deepEqual([enrolment]);
    // The endpoint and its key halves are a capability to wake somebody's phone; the file is filed as
    // the secret it is.
    should((await stat(document)).mode & 0o777).equal(0o600);
  });

  it('should replace an enrolment addressed by the same id rather than keeping both', async () => {
    const { repository } = await fixture('push-replace');
    await repository.save(record({ deviceName: 'Old name' }));

    await repository.save(record({ deviceName: 'New name', updatedAt: '2026-08-05T10:00:00.000Z' }));

    const stored = await repository.list();
    should(stored).have.length(1);
    should(stored[0]?.deviceName).equal('New name');
  });

  it('should forget a group and report how many there were to forget', async () => {
    const { repository } = await fixture('push-forget');
    const one = record();
    const two = record({ id: pushId('b'), subscription: subscription('https://push.example.test/send/two', 5) });
    await repository.save(one);
    await repository.save(two);

    should(await repository.forget([one.id, pushId('z')])).equal(1);
    should((await repository.list()).map(entry => entry.id)).deepEqual([two.id]);
    // Forgetting nothing writes nothing: the empty case is the common one at the end of a sweep.
    should(await repository.forget([])).equal(0);
  });

  it('should serialize concurrent writes so neither loses the other', async () => {
    const { repository } = await fixture('push-concurrent');
    const enrolments = ['a', 'b', 'c', 'd'].map((marker, index) =>
      record({ id: pushId(marker), subscription: subscription(`https://push.example.test/send/${index}`, index + 1) }),
    );

    // A read-modify-write of one array: without the queue each of these reads the document before any
    // of them wrote, and three of the four rows vanish.
    await Promise.all(enrolments.map(async enrolment => await repository.save(enrolment)));

    should((await repository.list()).map(entry => entry.id).sort()).deepEqual(enrolments.map(entry => entry.id).sort());
  });

  it('should keep serving after one write fails', async () => {
    const { paths, files } = await fixture('push-recover');
    let failNext = true;
    const repository = new StatePushRepository(paths, {
      readText: path => files.readText(path),
      setMode: (path, mode) => files.setMode(path, mode),
      writeTextAtomic: async (path, text) => {
        if (failNext) {
          failNext = false;
          throw new Error('the disk is full');
        }
        await files.writeTextAtomic(path, text);
      },
    });

    await repository.save(record()).should.be.rejectedWith(/disk is full/u);
    // The queue must not be poisoned by a rejection: one failed write cannot end this daemon's ability
    // to enrol anything for the rest of its life.
    await repository.save(record());
    should(await repository.list()).have.length(1);
  });

  it('should refuse a document it cannot read rather than reporting an empty fleet', async () => {
    const damaged = await fixture('push-damaged');
    await damaged.files.writeTextAtomic(damaged.document, '{');
    const wrongShape = await fixture('push-shape');
    await wrongShape.files.writeTextAtomic(
      wrongShape.document,
      JSON.stringify({ schemaVersion: 2, subscriptions: [] }),
    );
    const duplicated = await fixture('push-duplicate');
    await duplicated.files.writeTextAtomic(
      duplicated.document,
      JSON.stringify({ schemaVersion: 1, subscriptions: [record(), record()] }),
    );

    // The benign reading is the dangerous one: it answers every list with nobody enrolled, drops every
    // notification, and looks exactly like a machine with nothing to say.
    should((await refused(damaged.repository.list())).code).equal('corrupt_store');
    should((await refused(wrongShape.repository.list())).code).equal('corrupt_store');
    should((await refused(duplicated.repository.list())).code).equal('corrupt_store');
  });

  it('should refuse to persist an enrolment the wire could not describe', async () => {
    const { repository } = await fixture('push-invalid');

    await repository.save(record({ deviceId: 'not-a-device-id' })).should.be.rejected();
    should(await repository.list()).be.empty();
  });
});
