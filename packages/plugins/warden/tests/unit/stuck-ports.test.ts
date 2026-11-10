import { describe, it } from 'bun:test';
import should from 'should';
import { FakeAsks, sourceKey } from '@ferretry/core-asks/contract/testing';
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import { AsksWardenAgenda, NoticeEntries } from '../../daemon/asks.ts';
import type { MachineRaise } from '../../daemon/lib/machine-notices.ts';
import { conversationStuckInbox, conversationStuckInput } from '../../daemon/stuck-ports.ts';

/**
 * B187 C1: the two Warden checks that exist (`input-stuck.ts`, `inbox-stuck.ts`) get their ports from Conversation's
 * contract and nothing else — the ledger it reads, the one verified Enter its `warden` caller may ask for, and the
 * machine notice.
 */

const record = (sendId: string, over: Record<string, unknown> = {}) => ({
  v: 1,
  sendId,
  acceptedAt: '2026-11-07T12:00:00.000Z',
  acceptedTurn: 1,
  path: 'direct',
  message: 'secret words',
  attachmentIds: [],
  fate: 'unaccounted',
  ...over,
});

const message = (id: string, stateAt: string) => ({
  v: 1,
  id,
  sender: 'agent',
  text: 'waiting',
  attachmentIds: [],
  enqueuedAt: stateAt,
  state: 'queued',
  stateAt,
  revision: 1,
});

interface Calls {
  sends: Array<string | undefined>;
  pressed: Array<[string, unknown, string]>;
}

function conversation(
  pages: ReadonlyArray<{ sends: unknown[]; nextCursor?: string | null }>,
  press: unknown = { ok: true, value: 'holding' },
  queue: unknown[] = [],
  withActs = true,
): { api: ConversationApi; calls: Calls } {
  const calls: Calls = { sends: [], pressed: [] };
  const api = {
    sends: async (_ferret: string, cursor?: string) => {
      calls.sends.push(cursor);
      return pages[calls.sends.length - 1] ?? { sends: [] };
    },
    queue: async () => ({ messages: queue }),
    ...(withActs
      ? {
          resubmitStuck: async (ferret: string, caller: unknown, sendId: string) => {
            calls.pressed.push([ferret, caller, sendId]);
            return press;
          },
          retractedDraft: async () => 'send-back',
        }
      : {}),
  } as unknown as ConversationApi;
  return { api, calls };
}

const noList = { add: async () => undefined, remove: async () => undefined };

describe('B187 the input_stuck port over Conversation', () => {
  it('B187 reads every page of the ledger without the message text, and presses as the Warden', async () => {
    const { api, calls } = conversation(
      [
        { sends: [record('s1', { typedNotSent: true, attemptAt: '2026-11-07T12:01:00.000Z' })], nextCursor: 'c1' },
        { sends: [record('s2', { held: true, fromName: 'jaeda' })], nextCursor: null },
      ],
      { ok: true, value: 'submitted' },
    );
    const journal: string[] = [];
    const port = conversationStuckInput(api, noList, { record: type => void journal.push(type) });

    const sends = await port.sends('nelly');
    const pressed = await port.resubmit('nelly', 's1');

    should(calls.sends).eql([undefined, 'c1']);
    should(sends.map(send => send.sendId)).eql(['s1', 's2']);
    should(sends[0]).match({ typedNotSent: true, path: 'direct', fate: 'unaccounted' });
    should(sends[1]).match({ held: true, fromName: 'jaeda' });
    should(JSON.stringify(sends)).not.containEql('secret words');
    should(pressed).equal('submitted');
    should(calls.pressed).eql([['nelly', { kind: 'warden' }, 's1']]);
    should(await port.retracted?.('nelly')).equal('send-back');
    await port.markStalled('nelly', 'a message sits unsent');
    await port.clearStalled('nelly');
    should(journal).eql(['fleet.warden_input_stalled', 'fleet.warden_input_unstalled']);
  });

  it('B187 a refused or unavailable press is refused, and a Conversation without the acts offers no retraction', async () => {
    const refused = conversationStuckInput(
      conversation([], { ok: false, error: { code: 'forbidden', message: 'no' } }).api,
      noList,
      { record: () => undefined },
    );
    const without = conversationStuckInput(conversation([], undefined, [], false).api, noList, {
      record: () => undefined,
    });

    should(await refused.resubmit('nelly', 's1')).equal('refused');
    should(await without.resubmit('nelly', 's1')).equal('refused');
    should(without.retracted).be.undefined();
  });

  it('B187 the notice goes to the list it was given', async () => {
    const seen: string[] = [];
    const port = conversationStuckInput(
      conversation([]).api,
      {
        add: async notice => void seen.push(`add:${notice.sessionId}`),
        remove: async sessionId => void seen.push(`remove:${sessionId}`),
      },
      { record: () => undefined },
    );

    await port.add({ sessionId: 'nelly', title: 'nelly', line: 'stuck', since: '2026-11-07T12:00:00.000Z' });
    await port.remove('nelly');

    should(seen).eql(['add:nelly', 'remove:nelly']);
  });
});

describe('B187 the inbox_stuck port over Conversation', () => {
  it('B187 reads the queue and the ledger, and looks by reading the ledger', async () => {
    const { api, calls } = conversation([{ sends: [record('s1', { typedNotSent: true })] }, { sends: [] }], undefined, [
      message('m1', '2026-11-07T12:05:00.000Z'),
      message('m2', '2026-11-07T12:10:00.000Z'),
    ]);
    const port = conversationStuckInbox(api, noList);

    should(await port.queueWrittenAt('nelly')).equal(Date.parse('2026-11-07T12:10:00.000Z'));
    should((await port.queue('nelly')).map(each => each.id)).eql(['m1', 'm2']);
    should(await port.sends('nelly')).eql([
      { sendId: 's1', path: 'direct', fate: 'unaccounted', held: undefined, typedNotSent: true },
    ]);
    await port.trackerLook('nelly');
    await port.deliveryLook('nelly');

    should(calls.sends).have.length(2);
  });

  it('B187 an empty queue was written never', async () => {
    const port = conversationStuckInbox(conversation([]).api, noList);

    should(await port.queueWrittenAt('nelly')).be.undefined();
  });

  it('B187 finishing the box presses only for a send the tracker saw typed, and only as the Warden', async () => {
    const typed = [{ sends: [record('s1', { typedNotSent: true })] }];
    const done = conversation(typed, { ok: true, value: 'submitted' });
    const holding = conversation(typed, { ok: true, value: 'holding' });
    const refused = conversation(typed, { ok: false, error: { code: 'forbidden', message: 'no' } });
    const nothing = conversation([{ sends: [record('s2', { fate: 'delivered' })] }]);
    const without = conversation(typed, undefined, [], false);

    should(await conversationStuckInbox(done.api, noList).finishOwnDraft('nelly')).equal('clear');
    should(done.calls.pressed).eql([['nelly', { kind: 'warden' }, 's1']]);
    should(await conversationStuckInbox(holding.api, noList).finishOwnDraft('nelly')).equal('stuck');
    should(await conversationStuckInbox(refused.api, noList).finishOwnDraft('nelly')).equal('stuck');
    should(await conversationStuckInbox(nothing.api, noList).finishOwnDraft('nelly')).equal('foreign');
    should(nothing.calls.pressed).be.empty();
    should(await conversationStuckInbox(without.api, noList).finishOwnDraft('nelly')).equal('foreign');
  });

  it('B187 the notice goes to the list it was given', async () => {
    const seen: string[] = [];
    const port = conversationStuckInbox(conversation([]).api, {
      add: async notice => void seen.push(`add:${notice.sessionId}`),
      remove: async sessionId => void seen.push(`remove:${sessionId}`),
    });

    await port.add({ sessionId: 'nelly', title: 'nelly', line: 'stuck', since: '2026-11-07T12:00:00.000Z' });
    await port.remove('nelly');

    should(seen).eql(['add:nelly', 'remove:nelly']);
  });
});

describe('B187 a machine notice is one standing item on the machine board', () => {
  const request = (subject: string): MachineRaise => ({
    title: 'nelly is stuck on an unsent message',
    subject,
    why: 'the Enter never took',
    context: '- nelly',
    howToResolve: 'press Enter',
  });
  const open = async (asks: FakeAsks) => await asks.open({ source: sourceKey('daemon') });

  it('B187 raises it once, keeps it while the list stands, re-raises it only for a new member, and closes it empty', async () => {
    const asks = new FakeAsks();
    const notices = new AsksWardenAgenda(asks, new NoticeEntries()).machineNotices();

    await notices.raiseOrUpdate('warden:input-stuck', request('one'), ['nelly']);
    await notices.raiseOrUpdate('warden:input-stuck', request('one'), ['nelly']);
    const raised = await open(asks);
    should(raised).have.length(1);
    should(raised[0]?.subject).equal('nelly is stuck on an unsent message');

    // The owner closed it; the same members do not bring it back, a new one does.
    await asks.close({ ferret: raised[0]?.ferret as never, id: raised[0]?.id as never }, 'dismissed');
    await notices.raiseOrUpdate('warden:input-stuck', request('one'), ['nelly']);
    should(await open(asks)).have.length(0);
    await notices.raiseOrUpdate('warden:input-stuck', request('two'), ['nelly', 'ryu']);
    should(await open(asks)).have.length(1);

    await notices.resolve('warden:input-stuck', 'every ferret took its message');
    should(await open(asks)).have.length(0);
    // A refreshed, never-listed cause can be closed too.
    await notices.resolve('warden:inbox-stuck');
  });
});
