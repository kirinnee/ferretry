import { describe, it } from 'bun:test';
import should from 'should';
import {
  AgendaBoardUndelivered,
  AgendaChangeFanout,
  AgendaReplyDelivery,
} from '../../../../daemon/lib/agenda/observers.ts';
import type { AgendaReplyQueue, ReplyKey } from '../../../../daemon/lib/agenda/reply-batch.ts';
import type { AgendaBoardChange, AgendaChangeObserver } from '../../../../daemon/lib/agenda/service.ts';
import {
  type AgendaItem,
  AgendaSnapshotSchema,
  type ResolvedAgendaItem,
} from '../../../../daemon/lib/protocol/agenda.ts';

const AT = '2026-10-26T09:00:00.000Z';
const SESSION = 'session';

const openItem = (extra: Record<string, unknown> = {}): AgendaItem =>
  ({
    id: 'A3',
    title: 'Release the relay fix',
    kind: 'info',
    subject: 'The relay fix is ready',
    source: 'agent-raised',
    sourceRef: null,
    why: 'The build passed.',
    howToResolve: 'Read the result.',
    waitingSince: AT,
    raisedBy: 'agent',
    raisedBySession: SESSION,
    raisedByName: 'Morgan',
    ...extra,
  }) as unknown as AgendaItem;

const resolved = (extra: Record<string, unknown> = {}): ResolvedAgendaItem =>
  ({
    ...openItem(),
    resolvedAt: AT,
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    disposition: 'done',
    resolutionNote: '',
    ...extra,
  }) as unknown as ResolvedAgendaItem;

const snapshot = AgendaSnapshotSchema.parse({
  v: 1,
  sessionId: SESSION,
  items: [],
  resolved: [],
  count: 0,
  parseErrors: 0,
  updatedAt: AT,
});

const changeOf = (extra: Partial<AgendaBoardChange>): AgendaBoardChange => ({
  change: 'resolved',
  actor: { kind: 'human' },
  via: 'board',
  snapshot,
  ...extra,
});

const recordingQueue = (): { readonly queue: AgendaReplyQueue; readonly added: [string, string, string][] } => {
  const added: [string, string, string][] = [];
  return {
    added,
    queue: {
      add: async (sessionId, key, message) => {
        added.push([sessionId, key, message]);
      },
    },
  };
};

describe('the reply delivery', () => {
  it('should tell the ferret a bare done on a question it raised', async () => {
    // Arrange
    const { queue, added } = recordingQueue();
    const delivery = new AgendaReplyDelivery(queue, 'fy');

    // Act
    await delivery.changed(SESSION, changeOf({ addressed: resolved({ kind: 'reply' }) }));

    // Assert
    should(added).eql([[SESSION, 'A3', '[done !A3 «The relay fix is ready»] The owner marked this done.']]);
  });

  it('should keep a bare "Got it" on an info item to the board, telling the ferret nothing', async () => {
    // Arrange
    const { queue, added } = recordingQueue();
    const delivery = new AgendaReplyDelivery(queue, 'fy');

    // Act
    await delivery.changed(SESSION, changeOf({ addressed: resolved({ kind: 'info' }) }));

    // Assert
    should(added).eql([]);
  });

  it('should tell nothing for a closing that did not come from the owner on the board', async () => {
    // Arrange
    const { queue, added } = recordingQueue();
    const delivery = new AgendaReplyDelivery(queue, 'fy');
    const addressed = resolved({ kind: 'reply' });

    // Act
    await delivery.changed(SESSION, changeOf({ addressed, via: 'chat' as AgendaBoardChange['via'] }));
    await delivery.changed(SESSION, changeOf({ addressed, actor: { kind: 'daemon', cause: 'system' } }));
    await delivery.changed(SESSION, changeOf({}));
    await delivery.changed('another-session', changeOf({ addressed }));

    // Assert
    should(added).eql([]);
  });

  it('should tell a request for more information once per request counter', async () => {
    // Arrange
    const { queue, added } = recordingQueue();
    const delivery = new AgendaReplyDelivery(queue, 'fy');
    const item = openItem({ infoRequests: 2, history: [{ kind: 'needs-info', at: AT, note: 'which account?' }] });

    // Act
    await delivery.changed(SESSION, changeOf({ change: 'needs-info', item }));

    // Assert
    should(added).eql([[SESSION, 'A3~2', '[needs more info !A3 «The relay fix is ready»] which account?']]);
  });

  it('should tell a wish to discuss with the binary the ferret runs', async () => {
    // Arrange
    const { queue, added } = recordingQueue();
    const delivery = new AgendaReplyDelivery(queue, 'fy');
    const item = openItem({ infoRequests: 1, history: [{ kind: 'discuss', at: AT, note: 'why now?' }] });

    // Act
    await delivery.changed(SESSION, changeOf({ change: 'discussing', item }));

    // Assert
    should(added).have.length(1);
    should(added[0]?.[1]).equal('A3~1');
    should(added[0]?.[2]).containEql('`fy agenda edit A3`');
  });

  it('should tell an answer that rested the item under its own request key', async () => {
    // Arrange
    const { queue, added } = recordingQueue();
    const delivery = new AgendaReplyDelivery(queue, 'fy');
    const item = openItem({
      ownerAnswer: { at: AT, response: { kind: 'open-question', answer: 'yes' }, request: 3 },
    });

    // Act
    await delivery.changed(SESSION, changeOf({ change: 'answered', item }));

    // Assert
    should(added).eql([[SESSION, 'A3~3', '[answer to !A3 «The relay fix is ready»] yes']]);
  });

  it("should tell nothing for a rested answer on another ferret's item or without an answer", async () => {
    // Arrange
    const { queue, added } = recordingQueue();
    const delivery = new AgendaReplyDelivery(queue, 'fy');
    const answered = openItem({
      raisedBySession: 'someone-else',
      ownerAnswer: { at: AT, response: { kind: 'open-question', answer: 'yes' }, request: 1 },
    });

    // Act
    await delivery.changed(SESSION, changeOf({ change: 'answered', item: answered }));
    await delivery.changed(SESSION, changeOf({ change: 'answered', item: openItem() }));

    // Assert
    should(added).eql([]);
  });
});

describe('the board undelivered sink', () => {
  it('should reopen the item with the reason and the request counter of the key', async () => {
    // Arrange
    const calls: unknown[][] = [];
    const sink = new AgendaBoardUndelivered({
      undelivered: async (...args) => {
        calls.push(args);
        return {} as never;
      },
    });

    // Act
    await sink.undelivered(SESSION, 'A3~2' as ReplyKey, 'the ferret was gone');
    await sink.undelivered(SESSION, 'A4' as ReplyKey, 'no reply');

    // Assert
    should(calls).eql([
      [SESSION, 'A3', 'the ferret was gone', 2],
      [SESSION, 'A4', 'no reply', undefined],
    ]);
  });

  it('should leave a key that is about no item alone', async () => {
    // Arrange
    let called = false;
    const sink = new AgendaBoardUndelivered({
      undelivered: async () => {
        called = true;
        return {} as never;
      },
    });

    // Act
    await sink.undelivered(SESSION, 'instructions~abc' as ReplyKey, 'lost');

    // Assert
    should(called).be.false();
  });

  it('should stay total when the board cannot take it', async () => {
    // Arrange
    const sink = new AgendaBoardUndelivered({ undelivered: async () => await Promise.reject(new Error('board down')) });

    // Act
    const result = await sink.undelivered(SESSION, 'A3' as ReplyKey, 'lost');

    // Assert
    should(result).be.undefined();
  });
});

describe('the change fan-out', () => {
  it('should tell every observer and fail only for one that needs acceptance', async () => {
    // Arrange
    const told: string[] = [];
    const silent: AgendaChangeObserver = {
      changed: async () => {
        told.push('best-effort');
        throw new Error('ignored');
      },
    };
    const critical: AgendaChangeObserver = {
      requiresAcceptance: true,
      changed: async () => {
        told.push('critical');
        throw new Error('not accepted');
      },
    };
    const fanout = new AgendaChangeFanout([silent, critical, silent]);

    // Act
    const result = fanout.changed(SESSION, changeOf({}));

    // Assert
    await should(result).be.rejectedWith('agenda reply delivery was not durably accepted');
    should(told).eql(['best-effort', 'critical', 'best-effort']);
  });
});
