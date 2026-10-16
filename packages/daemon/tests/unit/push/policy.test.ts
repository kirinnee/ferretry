import { describe, it } from 'bun:test';
import should from 'should';
import { enrolmentConfirmation, pushDeviceView } from '../../../src/lib/push/index.ts';
import { AT, LATER, pushId, record, subscription } from './support.ts';

describe('pushDeviceView', () => {
  it('should describe an enrolment without the triple that can push to it', () => {
    const view = pushDeviceView(record({ updatedAt: LATER }));

    should(view).eql({
      id: pushId('a'),
      deviceName: 'Pixel 8',
      createdAt: AT,
      updatedAt: LATER,
      expirationTime: null,
    });
    // The endpoint and the key halves are the capability to wake somebody's phone. Their absence is
    // the whole point of projecting through the schema rather than spreading the record.
    should(Object.keys(view)).not.containEql('subscription');
    should(JSON.stringify(view)).not.match(/fcm\.googleapis\.com/u);
  });

  it('should carry an expiry the push service declared', () => {
    const expiring = record({
      subscription: { ...subscription('https://fcm.googleapis.com/send/two'), expirationTime: 1_800_000_000_000 },
    });

    should(pushDeviceView(expiring).expirationTime).equal(1_800_000_000_000);
  });

  it('should refuse a record the wire could not describe', () => {
    should(() => pushDeviceView(record({ id: 'not-a-push-id' }))).throw();
  });
});

describe('enrolmentConfirmation', () => {
  it('should name the device it confirms and open the application root', () => {
    const payload = enrolmentConfirmation('Pixel 8');

    should(payload).eql({
      version: 1,
      eventKey: 'push-enrolled',
      title: 'Notifications are on',
      body: 'Pixel 8 will be told when this machine needs you.',
      tag: 'push-enrolment',
      url: '/',
      count: 1,
    });
    // Deliberately NOT a session payload: it is about the enrolment, so no preference may silence it.
    should('kind' in payload).be.false();
  });
});
