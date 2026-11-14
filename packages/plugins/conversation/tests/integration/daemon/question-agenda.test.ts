import { describe, expect, test } from 'bun:test';
import type { AskDraft, AskRef, AskSummary, AsksApi, CloseReason } from '@ferretry/core-asks/contract';
import type { Instant } from '@ferretry/std';
import { QuestionSchema } from '../../../contract/index.ts';
import type { HarnessGate } from '../../../daemon/harness-seam.ts';
import { buildConversationA } from '../../../daemon/host.ts';
import { QUESTION_WATCH_MS } from '../../../daemon/questions/lib/watch.ts';
import type { TranscriptEvent } from '../../../daemon/seams/transcript-types.ts';

/**
 * A stored question is an obligation on the Agenda, for either harness (review round 1, B05): a Codex
 * `request_user_input` becomes ONE Asks item (source `question`, keyed by ferret and tool-use id, the stored question as
 * its ref); that exact item is resolved when the question is answered, retired by its transcript or withdrawn; and a
 * restart neither duplicates it nor leaves a stale one. The Asks port here keeps the real port's contract: a raise is
 * idempotent by `(source, entry)` FOR LIFE, so a closed obligation is never raised again.
 */

const CLOSED: HarnessGate = { send: false, interrupt: false };
const ASKED = '2026-11-14T01:00:00.000Z' as Instant;

const callEvent = (id: string, text = 'Which mode?'): TranscriptEvent =>
  ({
    kind: 'tool-call',
    timestamp: ASKED,
    call: {
      id,
      name: 'request_user_input',
      input: {},
      questions: [{ header: 'Mode', question: text, multiple: false, options: [{ label: 'Fast' }, { label: 'Slow' }] }],
    },
  }) as unknown as TranscriptEvent;
const resultEvent = (id: string): TranscriptEvent =>
  ({ kind: 'tool-result', timestamp: ASKED, result: { callId: id } }) as unknown as TranscriptEvent;

interface Item {
  readonly ref: AskRef;
  readonly draft: AskDraft;
  state: 'open' | 'closed';
  reason?: CloseReason;
}

/** The Asks port's contract as far as this source uses it: idempotent raise, open by source/entry, close by ref. */
function fakeAsks() {
  const items: Item[] = [];
  const fail = { raise: 0, close: 0 };
  const api: Pick<AsksApi, 'get' | 'raise' | 'open' | 'close'> = {
    get: async () => undefined,
    raise: async draft => {
      if (fail.raise > 0) {
        fail.raise -= 1;
        throw new Error('asks is unavailable');
      }
      const known = items.find(item => item.draft.source === draft.source && item.draft.entry === draft.entry);
      if (known !== undefined) return known.ref;
      const ref = { ferret: draft.ferret ?? '', id: `A${items.length + 1}` } as AskRef;
      items.push({ ref, draft, state: 'open' });
      return ref;
    },
    open: async filter =>
      items
        .filter(
          item =>
            item.state === (filter.state ?? 'open') &&
            (filter.source === undefined || item.draft.source === filter.source) &&
            (filter.entry === undefined || item.draft.entry === filter.entry),
        )
        .map(
          item =>
            ({
              id: item.ref.id,
              source: item.draft.source,
              entry: item.draft.entry,
              kind: item.draft.kind,
              subject: item.draft.subject,
              ferret: item.ref.ferret,
              state: item.state,
            }) as unknown as AskSummary,
        ),
    close: async (ref, reason) => {
      if (fail.close > 0) {
        fail.close -= 1;
        throw new Error('asks is unavailable');
      }
      const item = items.find(each => each.ref.ferret === ref.ferret && each.ref.id === ref.id);
      if (item !== undefined) Object.assign(item, { state: 'closed', reason });
    },
  };
  return { api, items, fail, open: () => items.filter(item => item.state === 'open') };
}

/** The daemon as part a touches it: a real in-memory state, the question watch's timer captured to be run by hand. */
function daemon(options: {
  files: Map<string, unknown>;
  asks: ReturnType<typeof fakeAsks>;
  events: { current: readonly TranscriptEvent[] };
}) {
  const { files, asks } = options;
  const key = (file: { path: string }, name?: string) => file.path.replace('*', name ?? '');
  const state = {
    read: async (file: { path: string }, name?: string) => ({ ok: true, value: files.get(key(file, name)) }),
    write: async (file: { path: string }, value: unknown, name?: string) => void files.set(key(file, name), value),
    remove: async (file: { path: string }, name?: string) => void files.delete(key(file, name)),
  };
  const timers: (() => void)[] = [];
  const published: string[] = [];
  const kernel = {
    state,
    clock: {
      now: () => '2026-11-14T01:00:10.000Z',
      nowMs: () => 0,
      every: () => () => undefined,
      after: (ms: number, run: () => void) => {
        // Only the question watch's own cadence: the send tracker and others keep their timers to themselves.
        if (ms !== QUESTION_WATCH_MS) return () => undefined;
        timers.push(run);
        return () => undefined;
      },
    },
    events: { publish: async (event: { name?: string }) => void published.push(String(event.name)) },
    ids: { mint: () => 'id' },
    log: { info: () => undefined, warn: () => undefined },
  } as never;
  const half = buildConversationA({
    kernel,
    ferrets: {
      get: async () => ({ id: 'cody', state: 'working' }),
      list: async () => [{ id: 'cody', harness: 'codex', state: 'working' }],
    } as never,
    asks: asks.api,
    hooks: {
      observe: () => undefined,
      transform: async (_hook: unknown, value: unknown) => ({ ok: true, value }),
    } as never,
    gate: CLOSED,
    questionEvents: async () => options.events.current,
  });
  /** One 2 s tick of the question watch (the Agenda's reconcile, then a look), run to the end. */
  const tick = async (): Promise<void> => {
    const run = timers.shift();
    run?.();
    for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
  };
  return { half, tick, published, stored: () => files.get('cody/question.json') };
}

const world = () => {
  const files = new Map<string, unknown>();
  const asks = fakeAsks();
  const events = { current: [] as readonly TranscriptEvent[] };
  return { files, asks, events, boot: () => daemon({ files, asks, events }) };
};

describe('a stored question reaches the Agenda as one Asks obligation', () => {
  test('a Codex question becomes exactly one item, however many looks, and its ref is the stored question', async () => {
    const w = world();
    const d = w.boot();
    w.events.current = [callEvent('call_1')];
    await d.tick();
    await d.tick();
    await d.tick();
    expect(w.asks.open()).toHaveLength(1);
    const [item] = w.asks.open();
    expect(item?.draft).toMatchObject({
      source: 'question',
      kind: 'form',
      ferret: 'cody',
      subject: 'Which mode?',
      raisedBy: { kind: 'daemon' },
    });
    expect(item?.draft.entry).toBe('cody:call_1');
    // The renderer's value: the stored question, the daemon's proof of its transcript left out.
    expect(QuestionSchema.parse(item?.draft.ref)).toMatchObject({ toolUseId: 'call_1', text: 'Which mode?' });
    expect(published(d)).toContain('conversation.question-asked');
  });

  test('its answer (the transcript carries the result) resolves that exact item as answered', async () => {
    const w = world();
    const d = w.boot();
    w.events.current = [callEvent('call_1')];
    await d.tick();
    w.events.current = [callEvent('call_1'), resultEvent('call_1')];
    await d.tick();
    expect(w.asks.open()).toHaveLength(0);
    expect(w.asks.items.map(item => [item.draft.entry, item.state, item.reason])).toEqual([
      ['cody:call_1', 'closed', 'answered'],
    ]);
    expect(d.stored()).toBeUndefined();
    // Nothing raises it again.
    await d.tick();
    expect(w.asks.items).toHaveLength(1);
  });

  test('a newer question resolves the older item and raises its own', async () => {
    const w = world();
    const d = w.boot();
    w.events.current = [callEvent('call_1')];
    await d.tick();
    w.events.current = [callEvent('call_1'), resultEvent('call_1'), callEvent('call_2', 'Which colour?')];
    await d.tick();
    expect(w.asks.items.map(item => [item.draft.entry, item.state])).toEqual([
      ['cody:call_1', 'closed'],
      ['cody:call_2', 'open'],
    ]);
  });

  test('a withdrawal (the ferret stopped) resolves the item as withdrawn', async () => {
    const w = world();
    const d = w.boot();
    w.events.current = [callEvent('call_1')];
    await d.tick();
    expect(w.asks.open()).toHaveLength(1);
    await d.half.withdrawQuestion('cody');
    expect(w.asks.items.map(item => [item.state, item.reason])).toEqual([['closed', 'withdrawn']]);
    expect(d.stored()).toBeUndefined();
  });

  test('a restart reconciles: no duplicate for the item already on the Agenda', async () => {
    const w = world();
    const first = w.boot();
    w.events.current = [callEvent('call_1')];
    await first.tick();
    expect(w.asks.items).toHaveLength(1);
    // The daemon restarts over the same files and the same Asks.
    const second = w.boot();
    await second.tick();
    await second.tick();
    expect(w.asks.items).toHaveLength(1);
    expect(w.asks.open()).toHaveLength(1);
  });

  test('a restart raises the card of a stored question whose raise never happened (a crash after the store)', async () => {
    const w = world();
    w.files.set('cody/question.json', {
      format: 1,
      toolUseId: 'call_9',
      text: 'Which mode?',
      options: [{ label: 'Fast' }, { label: 'Slow' }],
      multiple: false,
      askedAt: ASKED,
    });
    w.events.current = [callEvent('call_9')];
    const d = w.boot();
    await d.tick();
    expect(w.asks.open().map(item => item.draft.entry)).toEqual(['cody:call_9']);
  });

  test('a restart closes the card of a question that is no longer stored (a crash between the clear and the close)', async () => {
    const w = world();
    const first = w.boot();
    w.events.current = [callEvent('call_1')];
    await first.tick();
    w.files.delete('cody/question.json');
    w.events.current = [];
    const second = w.boot();
    await second.tick();
    expect(w.asks.open()).toHaveLength(0);
    expect(w.asks.items.map(item => item.reason)).toEqual(['withdrawn']);
  });

  test('an Asks failure never fails the question: the card is owed and raised on a later tick', async () => {
    const w = world();
    const d = w.boot();
    w.asks.fail.raise = 2;
    w.events.current = [callEvent('call_1')];
    await d.tick();
    // The question itself is stored and announced whatever Asks did.
    expect(d.stored()).toBeDefined();
    expect(w.asks.open()).toHaveLength(0);
    await d.tick();
    await d.tick();
    expect(w.asks.open().map(item => item.draft.entry)).toEqual(['cody:call_1']);
  });

  test('a close that failed is owed too: the card does not stay open forever', async () => {
    const w = world();
    const d = w.boot();
    w.events.current = [callEvent('call_1')];
    await d.tick();
    w.asks.fail.close = 1;
    w.events.current = [callEvent('call_1'), resultEvent('call_1')];
    await d.tick();
    expect(w.asks.open()).toHaveLength(1);
    await d.tick();
    expect(w.asks.open()).toHaveLength(0);
  });
});

/** The events the daemon published, by name (a placeholder that keeps the assertion readable). */
const published = (d: { published: string[] }): string[] => d.published;
