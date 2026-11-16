/** @ferretry/plugin-conversation/contract/testing — the contract's fake and conformance suite (§7.8). */
import { describe, expect, test } from 'bun:test';
import { err, type Instant, ok } from '@ferretry/std';
import {
  type ConversationApi,
  conversationFor,
  type KeepResult,
  type QueuedMessage,
  type SendRecord,
  type TranscriptEvent,
  type WorkHit,
} from '../index.ts';
import type { FerretId } from '@ferretry/core-ferrets/contract';

const refuse = (code: string, message: string) => err({ code, message });
const NOW = '2026-11-07T09:00:00.000Z' as Instant;

/**
 * An in-memory `ConversationApi`. It models the part the other plugins and the app lean on: the send ledger, the
 * queue, the current turn, and the pending question. Reads of harness files (logs, links) answer empty pages: there is
 * no harness behind a fake. The transcript's events are whatever a test hands `setEvents`; the owner's words are the
 * owner's own sends.
 */
export function fakeConversation(options: { readonly now?: () => Instant } = {}): ConversationApi & {
  /** Test control: a turn begins or ends. */
  setTurn(ferret: FerretId, turn: string | undefined): void;
  askQuestion(ferret: FerretId, toolUseId: string): void;
  /** Test control: what `transcriptEvents` answers for a ferret, oldest first. */
  setEvents(ferret: FerretId, events: readonly TranscriptEvent[]): void;
} {
  const now = options.now ?? (() => NOW);
  const turns = new Map<FerretId, string>();
  const queues = new Map<FerretId, QueuedMessage[]>();
  const sends = new Map<FerretId, SendRecord[]>();
  const questions = new Map<FerretId, string>();
  const events = new Map<FerretId, readonly TranscriptEvent[]>();
  const said = new Map<FerretId, string[]>();
  let counter = 0;
  const queueOf = (ferret: FerretId) => queues.get(ferret) ?? queues.set(ferret, []).get(ferret) ?? [];
  const sendsOf = (ferret: FerretId) => sends.get(ferret) ?? sends.set(ferret, []).get(ferret) ?? [];
  const noHarness = () => refuse('unavailable', 'a fake has no harness to read');
  const emptyHits: readonly WorkHit[] = [];
  const keepNothing: KeepResult = { kept: [], refused: [] };

  return {
    setTurn: (ferret, turn) => void (turn === undefined ? turns.delete(ferret) : turns.set(ferret, turn)),
    askQuestion: (ferret, toolUseId) => void questions.set(ferret, toolUseId),
    setEvents: (ferret, tail) => void events.set(ferret, tail),
    currentTurn: async ferret => turns.get(ferret),

    send: async (ferret, caller, request) => {
      const sendId = request.sendId ?? `send-${++counter}`;
      // The same send id twice is ONE message: the first request's answer, nothing queued or recorded again.
      const kept = sendsOf(ferret).find(record => record.sendId === sendId);
      if (kept !== undefined) {
        const waiting = queueOf(ferret).some(item => item.id === sendId && item.state === 'queued');
        return ok({ ferret, disposition: waiting ? 'queued' : 'delivered', sendId, fate: kept.fate });
      }
      if (caller.kind === 'owner') (said.get(ferret) ?? said.set(ferret, []).get(ferret))?.push(request.message);
      const busy = turns.has(ferret);
      sendsOf(ferret).push({
        v: 1,
        sendId,
        acceptedAt: now(),
        acceptedTurn: 0,
        path: 'direct',
        message: request.message,
        attachmentIds: request.attachmentIds ?? [],
        senderKind: caller.kind === 'owner' ? 'human' : caller.kind === 'warden' ? 'daemon' : 'agent',
        fate: busy ? 'queued' : 'delivered',
      });
      if (busy)
        queueOf(ferret).push({
          v: 1,
          id: sendId,
          sender: caller.kind === 'owner' ? 'human' : caller.kind === 'warden' ? 'daemon' : 'agent',
          text: request.message,
          attachmentIds: request.attachmentIds ?? [],
          enqueuedAt: now(),
          state: 'queued',
          stateAt: now(),
          revision: 1,
          waitReason: 'busy',
        });
      return ok({ ferret, disposition: busy ? 'queued' : 'delivered', sendId, fate: busy ? 'queued' : 'delivered' });
    },
    interrupt: async ferret => {
      turns.delete(ferret);
      return ok(undefined);
    },
    queue: async ferret => ({ messages: [...queueOf(ferret)] }),
    editQueued: async (ferret, message, request) => {
      const queue = queueOf(ferret);
      const at = queue.findIndex(item => item.id === message && item.state === 'queued');
      const found = queue[at];
      if (found === undefined) return refuse('not_found', `no queued message ${message}`);
      const edited = { ...found, text: request.text, revision: found.revision + 1, stateAt: now() };
      queue[at] = edited;
      return ok(edited);
    },
    cancelQueued: async (ferret, message) => {
      const queue = queueOf(ferret);
      const at = queue.findIndex(item => item.id === message && item.state === 'queued');
      const found = queue[at];
      if (found === undefined) return refuse('not_found', `no queued message ${message}`);
      const cancelled = { ...found, state: 'cancelled' as const, stateAt: now(), revision: found.revision + 1 };
      queue[at] = cancelled;
      return ok(cancelled);
    },
    sends: async ferret => ({ sends: [...sendsOf(ferret)] }),
    sendRecord: async (ferret, sendId) => sendsOf(ferret).find(record => record.sendId === sendId),
    retrySend: async () => noHarness(),
    cancelSend: async (ferret, sendId) => {
      const list = sendsOf(ferret);
      const at = list.findIndex(record => record.sendId === sendId);
      const found = list[at];
      if (found === undefined) return refuse('not_found', `no send ${sendId}`);
      const cancelled = { ...found, fate: 'cancelled' as const, fateAt: now() };
      list[at] = cancelled;
      return ok(cancelled);
    },
    enterSend: async () => noHarness(),
    composer: async () => noHarness(),

    transcript: async ferret => ok({ v: 1, ferret, messages: [], nextCursor: null }),
    transcriptEvents: async (ferret, options) => {
      const all = events.get(ferret) ?? [];
      return ok({ v: 1, ferret, events: options?.limit === undefined ? all : all.slice(-options.limit) });
    },
    transcriptLog: async (ferret, options) => {
      const all = events.get(ferret) ?? [];
      const tail = options?.limit === undefined ? all : all.slice(-options.limit);
      return ok({ v: 1, ferret, log: tail.map(event => JSON.stringify(event)).join('\n') });
    },
    ownerWords: async ferret => ok({ v: 1, ferret, words: [...new Set(said.get(ferret) ?? [])] }),
    logPage: async ferret => ok({ v: 1, ferret, log: '', start: 0, file: 'fake' }),
    logSearch: async (ferret, query) => ok({ v: 1, ferret, query, file: 'fake', matches: [], truncated: false }),

    question: async ferret => {
      const toolUseId = questions.get(ferret);
      return toolUseId === undefined
        ? undefined
        : { format: 1, toolUseId, text: 'A question', options: [], multiple: false, askedAt: now() };
    },
    answer: async (ferret, request) => {
      if (questions.get(ferret) !== request.toolUseId) return refuse('not_found', 'no such question is waiting');
      questions.delete(ferret);
      return ok(undefined);
    },

    compactAt: async () => ({ effective: 'auto', restartRequired: false, note: 'fake' }),
    setCompactAt: async (_ferret, patch) =>
      ok({ effective: patch.compactAt === 'inherit' ? 'auto' : patch.compactAt, restartRequired: false, note: 'fake' }),

    addAttachment: async () => noHarness(),
    attachment: async () => noHarness(),
    unlockAttachment: async () => noHarness(),
    relockAttachment: async () => noHarness(),

    saveRender: async () => noHarness(),
    renderMeta: async () => undefined,
    render: async () => undefined,

    draft: async (ferret, slot) => ({
      v: 1,
      ferret,
      ...(slot === undefined || slot === 'chat' ? {} : { slot }),
      generation: 'g1',
      epoch: 0,
      rev: 0,
      text: '',
      items: [],
      updatedAt: now(),
    }),
    editDraft: async () => noHarness(),

    searchWork: async () => ({ hits: [...emptyHits], total: 0, indexed: { cards: 0, asks: 0 } }),
    related: async () => ({ matches: [] }),

    links: async () => ({ conversations: [], matched: 0, skipped: 0 }),
    previewLink: async () => refuse('not_found', 'no such conversation'),
    keep: async () => keepNothing,
  };
}

/**
 * The fake as ONE consumer sees it: the same facade the real provider builds per consumer ({@link conversationFor}), so
 * a consumer's test that binds `perNeeder(needer => fakeConversationFor(needer.id, shared))` meets the Warden rule too.
 * `shared` is the fake whose state every consumer's view reads and writes.
 */
export function fakeConversationFor(
  consumer: string,
  shared: ReturnType<typeof fakeConversation> = fakeConversation(),
): ReturnType<typeof fakeConversation> {
  return { ...shared, ...conversationFor(consumer, shared) };
}

/** The behaviour every `ConversationApi` (the real one and every fake) keeps. */
export function conversationConformance(
  name: string,
  make: () => ConversationApi & { setTurn(ferret: FerretId, turn: string | undefined): void },
): void {
  const ferret = 'f1' as FerretId;
  describe(`ConversationApi conformance: ${name}`, () => {
    test('an idle ferret takes a message at once; a ferret mid-turn queues it, in order', async () => {
      const api = make();
      const first = await api.send(ferret, { kind: 'owner' }, { message: 'hello' });
      expect(first.ok && first.value.disposition).toBe('delivered');
      api.setTurn(ferret, 't1');
      expect(await api.currentTurn(ferret)).toBe('t1');
      await api.send(ferret, { kind: 'owner' }, { message: 'one' });
      await api.send(ferret, { kind: 'owner' }, { message: 'two' });
      expect((await api.queue(ferret)).messages.map(item => item.text)).toEqual(['one', 'two']);
    });

    test('a queued message can be edited and cancelled; a settled one cannot', async () => {
      const api = make();
      api.setTurn(ferret, 't1');
      const sent = await api.send(ferret, { kind: 'owner' }, { message: 'draft me' });
      if (!sent.ok || sent.value.sendId === undefined) throw new Error('setup');
      const edited = await api.editQueued(ferret, sent.value.sendId, { text: 'edited' });
      expect(edited.ok && edited.value.text).toBe('edited');
      const cancelled = await api.cancelQueued(ferret, sent.value.sendId);
      expect(cancelled.ok && cancelled.value.state).toBe('cancelled');
      const again = await api.editQueued(ferret, sent.value.sendId, { text: 'too late' });
      expect(again.ok).toBe(false);
    });

    test('every accepted send is in the ledger with its fate', async () => {
      const api = make();
      const sent = await api.send(ferret, { kind: 'owner' }, { message: 'ledger' });
      if (!sent.ok || sent.value.sendId === undefined) throw new Error('setup');
      const record = await api.sendRecord(ferret, sent.value.sendId);
      expect(record?.message).toBe('ledger');
      expect((await api.sends(ferret)).sends).toHaveLength(1);
    });

    test('the same send id twice is one message', async () => {
      const api = make();
      api.setTurn(ferret, 't1');
      const first = await api.send(ferret, { kind: 'owner' }, { message: 'once', sendId: 'board-reopen-1' });
      const again = await api.send(ferret, { kind: 'owner' }, { message: 'once', sendId: 'board-reopen-1' });
      expect(first.ok && first.value.sendId).toBe('board-reopen-1');
      expect(again.ok && again.value.sendId).toBe('board-reopen-1');
      if (!first.ok || !again.ok) throw new Error('setup');
      expect(again.value.disposition).toBe(first.value.disposition);
      expect((await api.sends(ferret)).sends).toHaveLength(1);
      expect((await api.queue(ferret)).messages).toHaveLength(1);
    });

    test('the transcript tail carries the tool calls and results a turn made, oldest first', async () => {
      const api = make();
      expect(await api.transcriptEvents(ferret)).toEqual({ ok: true, value: { v: 1, ferret, events: [] } });
    });

    test('the owner’s words are what the owner sent, not what a ferret did', async () => {
      const api = make();
      await api.send(ferret, { kind: 'owner' }, { message: 'build the board' });
      await api.send(ferret, { kind: 'ferret', ferret: 'f2' as FerretId }, { message: 'from a ferret' });
      const words = await api.ownerWords(ferret);
      expect(words.ok && words.value.words).toEqual(['build the board']);
    });

    test('an answer for a question nobody asked is refused', async () => {
      const result = await make().answer(ferret, { toolUseId: 'nope', labels: [] });
      expect(result.ok).toBe(false);
    });
  });
}
