import { describe, it } from 'bun:test';
import should from 'should';
import { readPushMessage } from '@ferretry/kernel/contract/push-envelope';
import { buzzPayload, clearPayload, enrolmentConfirmation, pushDeviceView } from '../../../../daemon/lib/push/index.ts';
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

describe('buzzPayload (K-push: a tag is never a reason to lose a buzz)', () => {
  const words = { title: 'Deploy approval', body: 'Ship the build?', url: '/ferrets/f1/chat?ask=A3' };

  it('should send a tag the worker reads, and name the event by it', () => {
    const payload = buzzPayload({ ...words, tag: 'agenda-mw89lrce-92c0fa14:A3' });

    should(payload).eql({
      version: 1,
      eventKey: 'agenda-mw89lrce-92c0fa14:A3',
      ...words,
      tag: 'agenda-mw89lrce-92c0fa14:A3',
      count: 1,
    });
    should(readPushMessage(payload)).eql({
      type: 'show',
      show: { ...words, tag: 'agenda-mw89lrce-92c0fa14:A3', count: 1 },
    });
  });

  it('should send a tag the worker could not read UNTAGGED, never refuse it', () => {
    // A ferret id may be 128 characters, so its agenda tag may be past the kernel's 128; a space is outside its charset.
    for (const tag of [`agenda-${'f'.repeat(128)}:A3`, 'two words', 'x'.repeat(200)]) {
      const payload = buzzPayload({ ...words, tag });

      should(Object.keys(payload)).not.containEql('tag');
      should(payload.eventKey).equal(tag);
      should(readPushMessage(payload)).eql({ type: 'show', show: { ...words, count: 1 } });
    }
  });

  it('should still refuse over-cap words at the sender', () => {
    should(() => buzzPayload({ ...words, tag: 'a', title: 'x'.repeat(201) })).throw();
  });
});

describe('clearPayload (a clear names tags and nothing else)', () => {
  it('should name the lines to take down for the ferret, and carry no words', () => {
    const payload = clearPayload(['pa-pa_0123456789abcdef01234567', 'attention-f1:A3'], 'f1');

    should(payload).eql({
      version: 1,
      kind: 'clear',
      eventKey: 'clear:pa-pa_0123456789abcdef01234567,attention-f1:A3',
      sessionId: 'f1',
      tags: ['pa-pa_0123456789abcdef01234567', 'attention-f1:A3'],
    });
    if (payload === undefined) throw new Error('expected a clear');
    should(readPushMessage(payload)).eql({
      type: 'clear',
      clear: { kind: 'clear', tags: ['pa-pa_0123456789abcdef01234567', 'attention-f1:A3'] },
    });
  });

  it('should name the machine when no ferret is named, and leave out a tag the worker could not find', () => {
    should(clearPayload(['pa-x', 'two words'])?.tags).eql(['pa-x']);
    should(clearPayload(['pa-x'])?.sessionId).equal('machine');
  });

  it('should send nothing when no tag fits, and never more than the sender’s bound', () => {
    should(clearPayload(['two words', ''])).be.undefined();
    should(clearPayload([])).be.undefined();
    should(clearPayload(Array.from({ length: 12 }, (_, index) => `pa-${String(index)}`))?.tags).have.length(8);
  });
});
