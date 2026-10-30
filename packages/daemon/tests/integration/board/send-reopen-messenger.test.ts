import { describe, it } from 'bun:test';
import should from 'should';
import type { ReopenAttachmentCarrier } from '../../../src/adapters/board/board-attachments.ts';
import { SendReopenMessenger, uncarriedFilesLine } from '../../../src/adapters/board/send-reopen-messenger.ts';
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
    const how = await typed.messenger.deliver('child', '&F1 was reopened by the owner: no', 'board-reopen-F1-3');

    // Assert
    should(how).equal('delivered');
    should(typed.sent).deepEqual([
      { id: 'child', sendId: 'board-reopen-F1-3', message: '&F1 was reopened by the owner: no' },
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

describe('a reopen with the files the owner attached', () => {
  const IMAGE = `att_${'a'.repeat(64)}`;
  const files = { from: 'child', ids: [IMAGE] };

  const typed = (carrier?: ReopenAttachmentCarrier) => {
    const sent: SendMessageRequest[] = [];
    const messenger = new SendReopenMessenger(
      {
        send: async request => {
          sent.push(request);
          return { disposition: 'queued' } as SendOutcome;
        },
      },
      undefined,
      carrier,
    );
    return { sent, messenger };
  };

  it('should send the files as the message attachments when they are already in the ferret session', async () => {
    // Arrange
    const { sent, messenger } = typed();

    // Act
    const how = await messenger.deliver('child', 'line', 'k', files);

    // Assert
    should(how).equal('delivered');
    should(sent).deepEqual([{ id: 'child', sendId: 'k', message: 'line', attachmentIds: [IMAGE] }]);
  });

  it('should carry the files into another ferret session first', async () => {
    // Arrange
    const carried: unknown[] = [];
    const { sent, messenger } = typed({
      carry: async (from, to, ids) => {
        carried.push([from, to, ids]);
        return ids;
      },
    });

    // Act
    await messenger.deliver('lead', 'line', 'k', files);

    // Assert
    should(carried).deepEqual([['child', 'lead', [IMAGE]]]);
    should(sent).deepEqual([{ id: 'lead', sendId: 'k', message: 'line', attachmentIds: [IMAGE] }]);
  });

  it('should still deliver the line, saying so plainly, when the files cannot be carried', async () => {
    // Arrange
    const failing = typed({
      carry: async () => {
        throw new Error('disk full');
      },
    });
    const without = typed();

    // Act
    await failing.messenger.deliver('lead', 'line', 'k', files);
    await without.messenger.deliver('lead', 'line', 'k', { from: 'child', ids: [IMAGE, `att_${'b'.repeat(64)}`] });

    // Assert
    should(failing.sent).deepEqual([{ id: 'lead', sendId: 'k', message: `line\n\n${uncarriedFilesLine(1)}` }]);
    should(without.sent[0]?.message).equal(`line\n\n${uncarriedFilesLine(2)}`);
    should(uncarriedFilesLine(1)).equal('The owner also attached a file that could not be copied to this chat.');
    should(uncarriedFilesLine(2)).equal('The owner also attached 2 files that could not be copied to this chat.');
  });
});
