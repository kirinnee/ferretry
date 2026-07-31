import type { SendDisposition } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import type { SessionEnvironment } from '../../../src/lib/session/ports.ts';
import { describeDisposition, describePark, planSend } from '../../../src/lib/session/send-plan.ts';

const HUMAN: SessionEnvironment = { cwd: '/work/repo' };
const IN_PANE: SessionEnvironment = { cwd: '/work/repo', callerSessionId: 'ses-caller' };

describe('planSend', () => {
  it('should compose the typed message and the file message in that order', () => {
    // Arrange / Act
    const plan = planSend({ message: ' first ', fileMessage: ' second ' }, HUMAN);

    // Assert
    should(plan.message).equal('first\n\nsecond');
    should(plan.now).be.false();
    should(plan.replyExpected).be.false();
    should(plan.park).be.undefined();
  });

  it('should keep a file-only message', () => {
    // Arrange / Act
    const plan = planSend({ fileMessage: 'from the file' }, HUMAN);

    // Assert
    should(plan.message).equal('from the file');
  });

  it('should refuse a send with no words, even with attachments', () => {
    // Arrange / Act / Assert
    should(() => planSend({ attachmentPaths: ['shot.png'] }, HUMAN)).throw(/provide a message/);
  });

  it('should carry the attachment paths for the controller to upload', () => {
    // Arrange / Act
    const plan = planSend({ message: 'look', attachmentPaths: ['a.png', 'b.pdf'] }, HUMAN);

    // Assert
    should(plan.attachmentPaths).deepEqual(['a.png', 'b.pdf']);
  });

  it('should mark an immediate steer', () => {
    // Arrange / Act
    const plan = planSend({ message: 'stop that', now: true }, HUMAN);

    // Assert
    should(plan.now).be.true();
  });

  it('should refuse --ask outside a session, since there is nothing to park', () => {
    // Arrange / Act / Assert
    should(() => planSend({ message: 'and you?', ask: true }, HUMAN)).throw(/only works from inside a session/);
  });

  it('should refuse a blank caller id as an in-pane caller', () => {
    // Arrange / Act / Assert
    should(() => planSend({ message: 'and you?', ask: true }, { cwd: '/x', callerSessionId: '  ' })).throw(
      /only works from inside a session/,
    );
  });

  it('should refuse --until without --ask, which would silently do nothing', () => {
    // Arrange / Act / Assert
    should(() => planSend({ message: 'hi', until: '30m' }, IN_PANE)).throw(/--until applies to `send --ask`/);
  });

  it('should plan a park with its deadline when a reply is expected', () => {
    // Arrange / Act
    const plan = planSend({ message: 'and you?', ask: true, until: '2h' }, IN_PANE);

    // Assert
    should(plan.replyExpected).be.true();
    should(plan.park).deepEqual({ callerSessionId: 'ses-caller', until: '2h' });
  });

  it('should plan an open-ended park when no deadline was given', () => {
    // Arrange / Act
    const plan = planSend({ message: 'and you?', ask: true }, IN_PANE);

    // Assert
    should(plan.park).deepEqual({ callerSessionId: 'ses-caller' });
  });
});

describe('describeDisposition', () => {
  const cases: readonly (readonly [SendDisposition, RegExp])[] = [
    ['delivered', /^delivered$/],
    ['queued', /auto-submits at the turn boundary/],
    ['revived', /revived the session/],
    ['queued-for-revive', /queued durably in the session inbox/],
  ];

  for (const [disposition, expected] of cases) {
    it(`should state what happened to a ${disposition} message`, () => {
      // Arrange / Act
      const actual = describeDisposition(disposition);

      // Assert
      should(actual).match(expected);
    });
  }
});

describe('describePark', () => {
  it('should refuse to park when nothing live received the message', () => {
    // Arrange / Act
    const actual = describePark({ disposition: 'queued-for-revive', peer: 'Hayden' });

    // Assert
    should(actual.parked).be.false();
    should(actual.note).match(/was not parked/);
  });

  it('should park with a deadline when one was given', () => {
    // Arrange / Act
    const actual = describePark({ disposition: 'queued', peer: 'Hayden', until: '2h' });

    // Assert
    should(actual.parked).be.true();
    should(actual.note).match(/parked awaiting a reply from Hayden \(until 2h\)/);
  });

  it('should name the backstop on an open-ended park', () => {
    // Arrange / Act
    const actual = describePark({ disposition: 'delivered', peer: 'ses-9' });

    // Assert
    should(actual.parked).be.true();
    should(actual.note).match(/open-ended; the 4h backstop still applies/);
  });
});
