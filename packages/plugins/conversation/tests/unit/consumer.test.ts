import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import { conversationFor, WARDEN_PLUGIN } from '../../contract/index.ts';
import { conversationConformance, fakeConversation, fakeConversationFor } from '../../contract/testing/index.ts';

const F1 = 'f1' as FerretId;

// The facade is the same one the real provider builds per consumer, so the fake's view keeps every shared behaviour.
conversationConformance('fakeConversationFor(board)', () => fakeConversationFor('board'));
conversationConformance('fakeConversationFor(warden)', () => fakeConversationFor(WARDEN_PLUGIN));

describe('a consumer’s view of Conversation (conversationFor)', () => {
  test('KCB-S the Warden claim is the Warden plugin’s alone: any other consumer is refused forbidden before the core is called', async () => {
    const core = fakeConversation();
    for (const consumer of ['board', 'lessons', 'usage', 'warden-impostor', '']) {
      const view = conversationFor(consumer, core);
      expect(await view.send(F1, { kind: 'warden' }, { message: 'x', sendId: 's-1' })).toEqual({
        ok: false,
        error: { code: 'forbidden', message: "only Ferretry's Warden may speak as the Warden" },
      });
    }
    expect((await core.sends(F1)).sends).toEqual([]);

    const sent = await conversationFor(WARDEN_PLUGIN, core).send(
      F1,
      { kind: 'warden' },
      { message: 'x', sendId: 's-1' },
    );
    expect(sent.ok).toBe(true);
    expect((await core.sendRecord(F1, 's-1'))?.senderKind).toBe('daemon');
  });

  test('KCB-S the owner and a ferret may still be named by any consumer', async () => {
    const view = conversationFor('board', fakeConversation());
    expect((await view.send(F1, { kind: 'owner' }, { message: 'a', sendId: 's-1' })).ok).toBe(true);
    expect(
      (await view.send(F1, { kind: 'ferret', ferret: 'f2' as FerretId }, { message: 'b', sendId: 's-2' })).ok,
    ).toBe(true);
  });

  test('G33 the port composer, a send’s Enter and its cancel are the Warden’s alone, and their refusal quotes nothing', async () => {
    const core = fakeConversation();
    await core.send(F1, { kind: 'owner' }, { message: 'a private message', sendId: 's-1' });
    const view = conversationFor('board', core);
    for (const refused of [
      await view.composer(F1, 'submit', 'a private draft'),
      await view.enterSend(F1, 's-1'),
      await view.cancelSend(F1, 's-1'),
    ]) {
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error('unreachable');
      expect(refused.error.code).toBe('forbidden');
      expect(JSON.stringify(refused)).not.toContain('private');
    }
    // The core was not reached: the cancel did not settle the send.
    expect((await core.sendRecord(F1, 's-1'))?.fate).not.toBe('cancelled');

    const warden = conversationFor(WARDEN_PLUGIN, core);
    const cancelled = await warden.cancelSend(F1, 's-1');
    expect(cancelled.ok && cancelled.value.fate).toBe('cancelled');
    // The composer reaches the core for the Warden (the fake has no pane, and says so).
    expect(await warden.composer(F1, 'submit', 'd')).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });

  test('KCB-S resubmitStuck is the Warden’s alone, and absent where the core has none', async () => {
    const withIt = {
      ...fakeConversation(),
      resubmitStuck: async () => ({ ok: true as const, value: 'submitted' as const }),
    };
    expect(await conversationFor('board', withIt).resubmitStuck!(F1, { kind: 'owner' }, 's-1')).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await conversationFor(WARDEN_PLUGIN, withIt).resubmitStuck!(F1, { kind: 'warden' }, 's-1')).toEqual({
      ok: true,
      value: 'submitted',
    });
    expect(conversationFor('board', fakeConversation()).resubmitStuck).toBeUndefined();
  });

  test('KCB-S two consumers share one conversation: what the Warden sent, another consumer reads', async () => {
    const shared = fakeConversation();
    await fakeConversationFor(WARDEN_PLUGIN, shared).send(F1, { kind: 'warden' }, { message: 'ping', sendId: 's-w' });
    expect((await fakeConversationFor('board', shared).sends(F1)).sends.map(row => row.sendId)).toEqual(['s-w']);
  });
});
