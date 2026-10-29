import { describe, it } from 'bun:test';
import should from 'should';
import {
  LedgerAttentionReceipts,
  PaneAttentionComposer,
  SendAttentionMessenger,
} from '../../../src/adapters/attention/send-attention-delivery.ts';
import { AttentionNotTyped } from '../../../src/lib/attention/index.ts';
import {
  composerOccupiedRefusal,
  composerUnreadableRefusal,
  type SendMessageRequest,
} from '../../../src/lib/session/send/service.ts';
import {
  type SendFate,
  type SendPaneObservation,
  SendPending,
  type SendRecord,
  SendRefused,
  SendUnconfirmed,
} from '../../../src/lib/session/send/types.ts';
import type { SessionId } from '../../../src/lib/session-id.ts';

const SESSION = 'mvtmuk2a-7e3cf736';
const AT = '2026-10-29T15:00:00.000Z';

const pane = (overrides: Partial<SendPaneObservation> = {}): SendPaneObservation => ({
  alive: true,
  dead: false,
  promptReady: true,
  activeWork: false,
  ...overrides,
});

const record = (sendId: string, fate: SendFate): SendRecord =>
  ({ sendId, fate, acceptedAt: AT, acceptedTurn: 1, path: 'direct', message: 'm' }) as SendRecord;

describe('the attention messenger', () => {
  const messenger = (failure?: Error) => {
    const seen: SendMessageRequest[] = [];
    return {
      seen,
      messenger: new SendAttentionMessenger({
        send: async request => {
          seen.push(request);
          if (failure !== undefined) throw failure;
          return undefined as never;
        },
      }),
    };
  };

  it('should hand the batch to the send service under its own send id', async () => {
    // Arrange
    const { seen, messenger: sender } = messenger();

    // Act
    await sender.send(SESSION, '[answer to !A1] yes', 'attention-x-A1-abc');

    // Assert
    should(seen).deepEqual([{ id: SESSION, sendId: 'attention-x-A1-abc', message: '[answer to !A1] yes' }]);
  });

  it('should say nothing was typed for a draft in the composer, an unreadable screen or a ferret still starting', async () => {
    // Act + Assert
    for (const failure of [
      composerOccupiedRefusal('half a thought'),
      composerUnreadableRefusal(),
      new SendPending('starting'),
    ])
      await should(messenger(failure).messenger.send(SESSION, 'm', 'id')).be.rejectedWith(AttentionNotTyped);
  });

  it('should accept a send typed but not yet proven, and pass any other refusal through', async () => {
    // Act + Assert
    await should(
      messenger(new SendUnconfirmed('typed, not proven', 'id')).messenger.send(SESSION, 'm', 'id'),
    ).be.fulfilled();
    const refused = await messenger(new SendRefused('session is quarantined'))
      .messenger.send(SESSION, 'm', 'id')
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    should(refused).be.instanceOf(SendRefused).and.not.be.instanceOf(AttentionNotTyped);
  });
});

describe('the attention composer reader', () => {
  const reading = (observed: SendPaneObservation | Error) =>
    new PaneAttentionComposer({
      observe: async (_id: SessionId) => {
        if (observed instanceof Error) throw observed;
        return observed;
      },
    });

  it('should read an empty composer — a ghost suggestion the pane reader left out included — as empty', async () => {
    // Act + Assert — the pane reader reports Claude's dim suggestion as no draft at all.
    should(await reading(pane()).state(SESSION)).equal('empty');
    should(await reading(pane({ draft: '   ' })).state(SESSION)).equal('empty');
  });

  it('should read a person’s draft as occupied, and a pane it cannot read as unreadable', async () => {
    // Act + Assert
    should(await reading(pane({ draft: 'actually, wait' })).state(SESSION)).equal('occupied');
    should(await reading(new Error('tmux gone')).state(SESSION)).equal('unreadable');
    should(await reading(pane()).state('not a session id!')).equal('unreadable');
  });

  it('should let a gone pane through: the send path revives the ferret with the message', async () => {
    // Act + Assert
    should(await reading(pane({ alive: false })).state(SESSION)).equal('empty');
    should(await reading(pane({ dead: true, draft: 'stale' })).state(SESSION)).equal('empty');
  });
});

describe('the attention receipts', () => {
  const receipts = (...records: SendRecord[]) => new LedgerAttentionReceipts({ list: async () => records });

  it('should count a send delivered only when the ledger proved it in the transcript', async () => {
    // Act + Assert
    should(await receipts(record('a', 'delivered')).receipt(SESSION, 'a')).deepEqual({ state: 'delivered' });
    should(await receipts(record('a', 'accepted')).receipt(SESSION, 'a')).deepEqual({ state: 'pending' });
    should(await receipts(record('a', 'queued')).receipt(SESSION, 'a')).deepEqual({ state: 'pending' });
    should(await receipts().receipt(SESSION, 'a')).deepEqual({ state: 'pending' });
  });

  it('should fail a send proven absent, unprovable, withdrawn or cancelled, saying why', async () => {
    // Act
    const fates: SendFate[] = ['timed_out', 'unaccounted', 'withdrawn', 'cancelled'];
    const results = await Promise.all(fates.map(fate => receipts(record('a', fate)).receipt(SESSION, 'a')));

    // Assert
    should(results.map(result => result.state)).deepEqual(['failed', 'failed', 'failed', 'failed']);
    should(results[1]).deepEqual({ state: 'failed', reason: 'nothing proves it reached the ferret' });
  });
});
