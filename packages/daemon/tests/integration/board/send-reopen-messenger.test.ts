import { describe, it } from 'bun:test';
import should from 'should';
import { SendReopenMessenger } from '../../../src/adapters/board/send-reopen-messenger.ts';
import type { SendMessageRequest, SendOutcome } from '../../../src/lib/session/send/service.ts';
import { SendPending, SendUnconfirmed } from '../../../src/lib/session/send/types.ts';

/** The reopen a card's ferret is told, through the send path's dispositions. */

describe('a reopen through the send path', () => {
  const sends = (answer: SendOutcome['disposition'] | Error) => {
    const sent: SendMessageRequest[] = [];
    return {
      sent,
      messenger: new SendReopenMessenger({
        send: async request => {
          sent.push(request);
          if (answer instanceof Error) throw answer;
          return { disposition: answer } as SendOutcome;
        },
      }),
    };
  };

  it('should send it as an owner message under its key, and read how it travelled', async () => {
    // Arrange
    const typed = sends('delivered');

    // Act
    const how = await typed.messenger.deliver('child', '[reopened &F1 by owner: no]', 'board-reopen-F1-3');

    // Assert
    should(how).equal('delivered');
    should(typed.sent).deepEqual([
      { id: 'child', sendId: 'board-reopen-F1-3', message: '[reopened &F1 by owner: no]' },
    ]);
    should(await sends('queued').messenger.deliver('child', 'x', 'k')).equal('delivered');
    should(await sends('sent').messenger.deliver('child', 'x', 'k')).equal('delivered');
    should(await sends('revived').messenger.deliver('child', 'x', 'k')).equal('resumed');
    should(await sends('queued-for-revive').messenger.deliver('child', 'x', 'k')).equal('held');
  });

  it('should count a typed but unproven send as delivered, and anything else that failed as absent', async () => {
    // Act / Assert
    should(await sends(new SendUnconfirmed('typed', 'k')).messenger.deliver('child', 'x', 'k')).equal('delivered');
    should(await sends(new SendPending('launching')).messenger.deliver('child', 'x', 'k')).equal('absent');
    should(await sends(new Error('session not found')).messenger.deliver('child', 'x', 'k')).equal('absent');
    should(await sends('delivered').messenger.deliver('../escape', 'x', 'k')).equal('absent');
  });
});
