import { describe, it } from 'bun:test';
import type { SendEnvironment } from '../../../cli/lib/send/ports.ts';
import type { SendResult } from '../../../contract/index.ts';
import should from 'should';
import { at } from '../../support/instant.ts';

type SendDisposition = SendResult['disposition'];
import {
  describeDisposition,
  describePark,
  describeSendResult,
  planSend,
  waitingInFerretryQueue,
} from '../../../cli/lib/send/plan.ts';

const HUMAN: SendEnvironment = {};
const IN_PANE: SendEnvironment = { callerFerret: 'ses-caller' };

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

  it('should refuse --ask outside a ferret, since there is nothing to park', () => {
    // Arrange / Act / Assert
    should(() => planSend({ message: 'and you?', ask: true }, HUMAN)).throw(/only works from inside a ferret/);
  });

  it('should refuse a blank caller id as an in-pane caller', () => {
    // Arrange / Act / Assert
    should(() => planSend({ message: 'and you?', ask: true }, { callerFerret: '  ' })).throw(
      /only works from inside a ferret/,
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
    should(plan.park).deepEqual({ callerFerret: 'ses-caller', until: '2h' });
  });

  it('should expect a reply without parking anybody, even from outside a ferret', () => {
    // Arrange / Act
    const human = planSend({ message: 'send your verdict', expectReply: true }, HUMAN);
    const inPane = planSend({ message: 'send your verdict', expectReply: true }, IN_PANE);

    // Assert
    should(human.replyExpected).be.true();
    should(human.park).be.undefined();
    should(inPane.replyExpected).be.true();
    should(inPane.park).be.undefined();
  });

  it('should plan an open-ended park when no deadline was given', () => {
    // Arrange / Act
    const plan = planSend({ message: 'and you?', ask: true }, IN_PANE);

    // Assert
    should(plan.park).deepEqual({ callerFerret: 'ses-caller' });
  });
});

describe('planSend label', () => {
  it('should default to action, and make a question (--ask, --expect-reply) or an interrupt a blocker', () => {
    should(planSend({ message: 'x' }, HUMAN).label).equal('action');
    should(planSend({ message: 'x', ask: true }, IN_PANE).label).equal('blocker');
    should(planSend({ message: 'x', now: true }, HUMAN).label).equal('blocker');
    should(planSend({ message: 'x', expectReply: true }, HUMAN).label).equal('blocker');
    should(planSend({ message: 'x', expectReply: true, kind: 'action' }, HUMAN).label).equal('blocker');
    should(planSend({ message: 'x', ask: true, kind: 'action' }, IN_PANE).label).equal('blocker');
  });

  it('should carry an explicit label', () => {
    should(planSend({ message: 'x', kind: 'fyi' }, HUMAN).label).equal('fyi');
    should(planSend({ message: 'x', kind: 'blocker' }, HUMAN).label).equal('blocker');
    should(planSend({ message: 'x', kind: ' action ' }, HUMAN).label).equal('action');
  });

  it('should refuse an FYI that is a question or an interrupt, and an unknown word', () => {
    should(() => planSend({ message: 'x', kind: 'fyi', ask: true }, IN_PANE)).throw(/a question is never an FYI/);
    should(() => planSend({ message: 'x', kind: 'fyi', expectReply: true }, HUMAN)).throw(/a question is never an FYI/);
    should(() => planSend({ message: 'x', kind: 'fyi', now: true }, HUMAN)).throw(/a question is never an FYI/);
    should(() => planSend({ message: 'x', kind: 'urgent' }, HUMAN)).throw(
      /--kind must be one of blocker \| action \| fyi/,
    );
  });
});

describe('describeDisposition', () => {
  const cases: readonly (readonly [SendDisposition, RegExp])[] = [
    ['delivered', /^delivered$/],
    ['queued', /auto-submits at the turn boundary/],
    ['revived', /revived the ferret/],
    ['queued-for-revive', /queued durably in the ferret's inbox/],
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

describe('describeSendResult', () => {
  it('should say a message still in Ferretry’s queue is not delivered, and why, never the agent’s own queue', () => {
    const said = describeSendResult({ disposition: 'queued', fate: 'accepted', waitReason: 'question' });
    should(said).match(
      /^NOT delivered yet: it is waiting in Ferretry's queue \(not the agent's\), because the agent is asking a question/,
    );
    should(said).not.match(/auto-submits/);
  });

  it('should name the unconfirmed send it waits behind, and the re-submit that was attempted', () => {
    const said = describeSendResult({
      disposition: 'queued',
      fate: 'accepted',
      waitReason: 'draft',
      waitBehind: 'send-0',
    });
    should(said).match(/behind an unconfirmed earlier send \(send-0\)/);
    should(said).match(/attempted a re-submit \(pressed Enter\)/);
  });

  it('should read a queued answer with no wait reason as waiting, and leave a typed one as it was', () => {
    should(describeSendResult({ disposition: 'queued', fate: 'accepted' })).match(/not typed into the agent yet/);
    should(describeSendResult({ disposition: 'queued', fate: 'queued' })).match(/auto-submits at the turn boundary/);
    should(describeSendResult({ disposition: 'delivered', fate: 'accepted' })).equal('delivered');
    should(waitingInFerretryQueue({ disposition: 'sent', fate: 'accepted' })).be.false();
  });
});

describe('describeSendResult for a held message', () => {
  it('should say an action is held to combine, and an FYI waits for the turn end', () => {
    const held = { disposition: 'queued', fate: 'accepted', heldUntil: at('2026-01-01T00:11:00.000Z') } as const;
    should(describeSendResult({ ...held, label: 'action' })).match(
      /^held until \d\d:\d\d:\d\d to combine with other messages \(action\); not typed yet; do not resend$/,
    );
    should(describeSendResult({ ...held, label: 'fyi' })).match(/held as an FYI .*turn ends.*do not resend/);
    should(waitingInFerretryQueue({ disposition: 'sent', fate: 'accepted', heldUntil: held.heldUntil })).be.true();
  });
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
