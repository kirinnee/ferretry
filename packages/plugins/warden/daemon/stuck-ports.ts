import type { QueuedMessage } from './lib/protocol.ts';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import type {
  InboxSend,
  StuckInboxList,
  StuckInputList,
  StuckInputPress,
  StuckInputSend,
  WardenStuckInboxPort,
  WardenStuckInputPort,
} from './lib/index.ts';

/** At most this many pages of one ferret's send ledger are read in one look (a ledger is bounded; a loop is a bug). */
const SEND_PAGES = 64;

/** Every send one ferret was sent, the latest line of each. Throws when Conversation cannot be read. */
async function readSends(conversation: ConversationApi, ferret: FerretId) {
  const sends = [];
  let cursor: string | undefined;
  for (let page = 0; page < SEND_PAGES; page++) {
    const listed = await conversation.sends(ferret, cursor);
    sends.push(...listed.sends);
    if (listed.nextCursor === undefined || listed.nextCursor === null) break;
    cursor = listed.nextCursor;
  }
  return sends;
}

/** The ledger as the stuck-input check reads it: the fields of a wire record it needs, no message text. */
function stuckInputSendOf(send: Awaited<ReturnType<typeof readSends>>[number]): StuckInputSend {
  return {
    sendId: send.sendId,
    path: send.path,
    fate: send.fate,
    acceptedAt: send.acceptedAt,
    attemptAt: send.attemptAt,
    fateAt: send.fateAt,
    deadlineAt: send.deadlineAt,
    typedNotSent: send.typedNotSent,
    held: send.held,
    unaccountedReason: send.unaccountedReason,
    fromName: send.fromName,
  };
}

/** What the stalled mark can do on this machine: Ferrets offers no health mark yet, so it is said in the journal only. */
export interface StalledMarkLog {
  record(type: string, data: Readonly<Record<string, string>>): void;
}

/**
 * The Warden's `input_stuck` port over Conversation (B187 C1): the ledger it reads, the ONE verified Enter its
 * `warden` caller may ask for, the taken-back pointer the send path reads, and the machine notice. Everything is
 * through Conversation's contract, never around it.
 *
 * GAP(warden): Ferrets offers no `stalled` health mark, so `markStalled` / `clearStalled` are journalled
 * (`fleet.warden_input_stalled` / `…_unstalled`) and mark nothing; the notice and the flag carry the news.
 */
export function conversationStuckInput(
  conversation: ConversationApi,
  notice: Pick<StuckInputList, 'add' | 'remove'>,
  log: StalledMarkLog,
): WardenStuckInputPort {
  return {
    sends: async sessionId => (await readSends(conversation, sessionId as FerretId)).map(stuckInputSendOf),
    resubmit: async (sessionId, sendId): Promise<StuckInputPress> => {
      if (conversation.resubmitStuck === undefined) return 'refused';
      const pressed = await conversation.resubmitStuck(sessionId as FerretId, { kind: 'warden' }, sendId);
      return pressed.ok ? pressed.value : 'refused';
    },
    ...(conversation.retractedDraft === undefined
      ? {}
      : { retracted: async (sessionId: string) => await conversation.retractedDraft?.(sessionId as FerretId) }),
    markStalled: async (sessionId, reason) => {
      log.record('fleet.warden_input_stalled', { sessionId, reason });
    },
    clearStalled: async sessionId => {
      log.record('fleet.warden_input_unstalled', { sessionId });
    },
    add: async entry => await notice.add(entry),
    remove: async sessionId => await notice.remove(sessionId),
  };
}

/**
 * The Warden's `inbox_stuck` port over Conversation (B187 C1). A READ OF THE LEDGER IS A LOOK: Conversation's
 * `sends` asks the send tracker to look first (bounded), so `trackerLook` is that read. The verified finish of a draft
 * that is provably ours is the same single Enter `resubmitStuck` presses for the open send whose text the tracker saw
 * typed. The deliverer's own look is not on Conversation's port, so `deliveryLook` does nothing here: the queue's
 * deliverer already looks on its own schedule and at every turn boundary.
 */
export function conversationStuckInbox(
  conversation: ConversationApi,
  notice: Pick<StuckInboxList, 'add' | 'remove'>,
): WardenStuckInboxPort {
  const inboxSends = async (sessionId: string): Promise<readonly InboxSend[]> =>
    (await readSends(conversation, sessionId as FerretId)).map(send => ({
      sendId: send.sendId,
      path: send.path,
      fate: send.fate,
      held: send.held,
      typedNotSent: send.typedNotSent,
    }));
  return {
    // A queue has no write stamp on Conversation's port: its newest line stands for it, and an empty queue has none.
    queueWrittenAt: async sessionId => {
      const queue = await conversation.queue(sessionId as FerretId);
      const stamps = queue.messages.map(message => Date.parse(message.stateAt)).filter(Number.isFinite);
      return stamps.length === 0 ? undefined : Math.max(...stamps);
    },
    queue: async sessionId => (await conversation.queue(sessionId as FerretId)).messages as readonly QueuedMessage[],
    sends: inboxSends,
    trackerLook: async sessionId => {
      await conversation.sends(sessionId as FerretId);
    },
    finishOwnDraft: async sessionId => {
      const sends = await readSends(conversation, sessionId as FerretId);
      const typed = sends.find(send => send.typedNotSent === true && send.fate !== 'delivered');
      if (typed === undefined || conversation.resubmitStuck === undefined) return 'foreign';
      const pressed = await conversation.resubmitStuck(sessionId as FerretId, { kind: 'warden' }, typed.sendId);
      return pressed.ok && pressed.value === 'submitted' ? 'clear' : 'stuck';
    },
    deliveryLook: async () => undefined,
    add: async entry => await notice.add(entry),
    remove: async sessionId => await notice.remove(sessionId),
  };
}
