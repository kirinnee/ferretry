import { describe, it } from 'bun:test';
import should from 'should';
import { AutoTitlingSendChannel } from '../../../src/adapters/names/index.ts';
import type { InboundMessage, SendChannel } from '../../../src/lib/session/send/types.ts';
import { parseSessionId } from '../../../src/lib/session-id.ts';

const ID = parseSessionId('11111111-1111-4111-8111-111111111111');

const harness = (config: Record<string, unknown> | undefined) => {
  const recorded: InboundMessage[] = [];
  let writes = 0;
  let stored = config;
  const inner: SendChannel = {
    recordInbound: async (_id, entry) => {
      recorded.push(entry);
    },
    recordOutbound: async () => undefined,
  };
  const storage = {
    findSession: () => (stored === undefined ? undefined : ({} as never)),
    readConfig: async () => stored as never,
    updateConfig: async (_id: unknown, transform: (current: never) => unknown) => {
      writes += 1;
      stored = transform(stored as never) as Record<string, unknown>;
      return stored as never;
    },
  };
  const channel = new AutoTitlingSendChannel(inner, storage as never);
  return { channel, recorded, stored: () => stored, writes: () => writes };
};

const entry = (extra: Partial<InboundMessage> = {}): InboundMessage => ({
  at: '2026-10-30T00:00:00.000Z',
  message: 'Fix the sidebar titles',
  ...extra,
});

describe('titling a session from its first owner message', () => {
  it('should title a placeholder-named session and still record the message', async () => {
    const h = harness({ name: 'interactive', nameSource: 'auto' });
    await h.channel.recordInbound(ID, entry());
    should(h.recorded.length).equal(1);
    should(h.stored()).containEql({ name: 'Fix the sidebar titles', nameSource: 'auto' });
  });

  it('should not retitle on a later message, nor write when nothing changes', async () => {
    const h = harness({ name: 'interactive', nameSource: 'auto' });
    await h.channel.recordInbound(ID, entry());
    await h.channel.recordInbound(ID, entry({ message: 'And another thing' }));
    should(h.stored()).containEql({ name: 'Fix the sidebar titles' });
    should(h.writes()).equal(1);
  });

  it('should leave an owner-chosen name alone', async () => {
    const h = harness({ name: 'interactive', nameSource: 'owner' });
    await h.channel.recordInbound(ID, entry());
    should(h.writes()).equal(0);
  });

  it("should ignore a teammate's or the daemon's message", async () => {
    const h = harness({ name: 'interactive', nameSource: 'auto' });
    await h.channel.recordInbound(ID, entry({ from: 'peer-session' }));
    await h.channel.recordInbound(ID, entry({ reason: 'delivery-failed' }));
    should(h.writes()).equal(0);
  });

  it('should never fail the send when the title cannot be written', async () => {
    const h = harness({ name: 'interactive', nameSource: 'auto' });
    const failing = new AutoTitlingSendChannel(
      { recordInbound: async () => undefined, recordOutbound: async () => undefined },
      {
        findSession: () => ({}) as never,
        readConfig: async () => {
          throw new Error('disk gone');
        },
        updateConfig: async () => undefined as never,
      } as never,
    );
    await failing.recordInbound(ID, entry());
    should(h.writes()).equal(0);
  });
});
