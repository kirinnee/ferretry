import { describe, it } from 'bun:test';
import should from 'should';
import { acceptsDispatch, enrolmentConfirmation, pushDeviceView } from '../../../src/lib/push/index.ts';
import { AT, allEvents, LATER, pushId, record, subscription } from './support.ts';

describe('pushDeviceView', () => {
  it('should describe an enrolment without the triple that can push to it', () => {
    const view = pushDeviceView(record({ updatedAt: LATER }));

    should(view).eql({
      id: pushId('a'),
      deviceName: 'Pixel 8',
      createdAt: AT,
      updatedAt: LATER,
      expirationTime: null,
      prefs: allEvents,
    });
    // The endpoint and the key halves are the capability to wake somebody's phone. Their absence is
    // the whole point of projecting through the schema rather than spreading the record.
    should(Object.keys(view)).not.containEql('subscription');
    should(JSON.stringify(view)).not.match(/push\.example\.test/u);
  });

  it('should carry an expiry the push service declared', () => {
    const expiring = record({
      subscription: { ...subscription('https://push.example.test/send/two'), expirationTime: 1_800_000_000_000 },
    });

    should(pushDeviceView(expiring).expirationTime).equal(1_800_000_000_000);
  });

  it('should refuse a record the wire could not describe', () => {
    should(() => pushDeviceView(record({ id: 'not-a-push-id' }))).throw();
  });
});

describe('acceptsDispatch', () => {
  const sessionPayload = (kind: 'attention' | 'failed') => ({
    version: 1 as const,
    eventKey: 'e1',
    title: 'Session needs you',
    body: '',
    tag: 't1',
    url: '/',
    count: 1,
    sessionId: 's1',
    kind,
  });

  it('should deliver a notification about no session whatever the preferences say', () => {
    const silent = {
      events: { attention: false, question: false, failed: false, completed: false },
      interactiveOnly: true,
    };

    should(acceptsDispatch(silent, { payload: enrolmentConfirmation('Pixel 8') })).be.true();
  });

  it('should refuse the kinds the device switched off and deliver the ones it kept', () => {
    const partial = { events: { ...allEvents.events, failed: false }, interactiveOnly: false };

    should(acceptsDispatch(partial, { payload: sessionPayload('failed') })).be.false();
    should(acceptsDispatch(partial, { payload: sessionPayload('attention') })).be.true();
  });

  it('should refuse an unattended session when the device asked for interactive sessions only', () => {
    const interactive = { events: allEvents.events, interactiveOnly: true };

    should(acceptsDispatch(interactive, { payload: sessionPayload('attention'), interactive: false })).be.false();
    should(acceptsDispatch(interactive, { payload: sessionPayload('attention'), interactive: true })).be.true();
    // Unstated is not "unattended": a caller that did not say must not be read as having said no.
    should(acceptsDispatch(interactive, { payload: sessionPayload('attention') })).be.true();
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
