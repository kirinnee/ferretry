import { FakeMailbox } from '@ferretry/core-mailbox/contract/testing';
import { describe, expect, test } from 'bun:test';
import {
  type AskDraft,
  AskDraftSchema,
  AskRefusedError,
  type AskRef,
  type AskSummary,
  type AsksApi,
  type CloseReason,
} from '@ferretry/core-asks/contract';
import type { Instant } from '@ferretry/std';
import { CONVERSATION_STATE, QuestionSchema } from '../../../contract/index.ts';
import { memoryStatePort } from '../../support/state.ts';
import type { HarnessGate } from '@ferretry/core-mailbox/contract';
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
  const fail = { raise: 0, close: 0, attempts: 0, refuse: undefined as { message: string; code?: string } | undefined };
  const api: Pick<AsksApi, 'get' | 'raise' | 'open' | 'close'> = {
    get: async () => undefined,
    raise: async draft => {
      fail.attempts += 1;
      // The real port reads the draft first, and the board may read it and say no.
      AskDraftSchema.parse(draft);
      if (fail.refuse !== undefined) throw new AskRefusedError(fail.refuse.message, fail.refuse.code);
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
  /** Another Ferrets (a live form to type into, more than one ferret): the default has one Codex ferret. */
  ferrets?: unknown;
}) {
  const { files, asks } = options;
  const key = (file: { path: string }, name?: string) => file.path.replace('*', name ?? '');
  const state = {
    // The answer ledger's lines and the rest of the state port are the real in-memory ones; the files are this map.
    ...memoryStatePort(CONVERSATION_STATE),
    read: async (file: { path: string }, name?: string) => ({ ok: true, value: files.get(key(file, name)) }),
    write: async (file: { path: string }, value: unknown, name?: string) => void files.set(key(file, name), value),
    remove: async (file: { path: string }, name?: string) => void files.delete(key(file, name)),
  };
  const timers: (() => void)[] = [];
  const published: string[] = [];
  const warned: string[] = [];
  const kernel = {
    state,
    clock: {
      now: () => '2026-11-14T01:00:10.000Z',
      nowMs: () => 0,
      sleep: async () => undefined,
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
    log: { info: () => undefined, warn: (line: string) => void warned.push(line) },
  } as never;
  const half = buildConversationA({
    mailbox: new FakeMailbox(),
    kernel,
    ferrets: (options.ferrets ?? {
      get: async () => ({ id: 'cody', state: 'working' }),
      list: async () => [{ id: 'cody', harness: 'codex', state: 'working' }],
    }) as never,
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
  return { half, tick, published, warned, stored: () => files.get('cody/question.json') };
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

  test("the card is a form of the question's own fields, which the board takes", async () => {
    const w = world();
    const d = w.boot();
    w.events.current = [callEvent('call_1')];
    await d.tick();
    const [item] = w.asks.open();
    expect(item?.draft).toMatchObject({
      kind: 'form',
      fields: [
        {
          id: '1',
          type: 'one',
          name: 'Mode',
          label: 'Which mode?',
          options: [{ label: 'Fast' }, { label: 'Slow' }],
        },
      ],
    });
  });

  test('a question the board refuses is said once and never tried again, not every two seconds', async () => {
    const w = world();
    const d = w.boot();
    w.asks.fail.refuse = { message: 'a form needs at least one field (--field)', code: 'invalid' };
    w.events.current = [callEvent('call_1')];
    for (let i = 0; i < 6; i += 1) await d.tick();
    const attempts = w.asks.fail.attempts;
    for (let i = 0; i < 6; i += 1) await d.tick();
    expect(w.asks.fail.attempts).toBe(attempts);
    expect(attempts).toBeLessThanOrEqual(2);
    expect(d.warned.filter(line => line.includes('will not try again'))).toHaveLength(1);
    expect(d.warned.some(line => line.includes('could not reconcile'))).toBe(false);
  });

  test('a full agenda is said once and asked again when the board changes, not dropped and not every two seconds', async () => {
    const w = world();
    const d = w.boot();
    w.asks.fail.refuse = { message: 'this session already has 20 unresolved items', code: 'full' };
    w.events.current = [callEvent('call_1')];
    for (let i = 0; i < 6; i += 1) await d.tick();
    const attempts = w.asks.fail.attempts;
    for (let i = 0; i < 6; i += 1) await d.tick();
    expect(w.asks.fail.attempts).toBe(attempts);
    expect(w.asks.open()).toHaveLength(0);
    expect(d.warned.filter(line => line.includes('when the agenda has room'))).toHaveLength(1);
    // The board changes but is still full: asked again, and no second line.
    await d.half.onAsksChanged();
    expect(d.warned.filter(line => line.includes('when the agenda has room'))).toHaveLength(1);
    // A slot frees: the next change raises the card, and nothing asks again after that.
    w.asks.fail.refuse = undefined;
    await d.half.onAsksChanged();
    expect(w.asks.open().map(item => item.draft.entry)).toEqual(['cody:call_1']);
    const raised = w.asks.fail.attempts;
    await d.half.onAsksChanged();
    await d.tick();
    expect(w.asks.fail.attempts).toBe(raised);
    expect(w.asks.items).toHaveLength(1);
  });

  test('a question with no option to pick is an open question, still a card (a form has one reply box)', async () => {
    const w = world();
    const d = w.boot();
    w.events.current = [
      {
        kind: 'tool-call',
        timestamp: ASKED,
        call: {
          id: 'call_9',
          name: 'request_user_input',
          input: {},
          questions: [
            { header: 'A', question: 'Why?', multiple: false, options: [] },
            { header: 'B', question: 'And why not?', multiple: false, options: [] },
          ],
        },
      } as unknown as TranscriptEvent,
    ];
    await d.tick();
    expect(w.asks.open().map(item => item.draft.kind)).toEqual(['reply']);
    expect(w.asks.open()[0]?.draft).not.toHaveProperty('fields');
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

/**
 * The owner's answer on the Agenda reaches the ferret (`ask.sources:question` `apply`): typed into the ferret's own
 * question form through the real answer path, over a scripted pane. The card is the Agenda's to resolve afterwards.
 */
const RULE = '─'.repeat(40);
const FORM = {
  format: 1,
  toolUseId: 't1',
  text: 'Deploy?',
  options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Other' }],
  multiple: false,
  askedAt: '2026-11-14T00:59:00.000Z',
  transcript: '/transcripts/cody.jsonl',
};

/** One ferret's pane: the form redraws as keys land, and Enter finishes it. */
class Pane {
  readonly keys: string[] = [];
  readonly pastes: string[] = [];
  private mode: 'form' | 'ready' = 'form';
  private cursor = 0;
  private frame() {
    const visible =
      this.mode === 'ready'
        ? '> '
        : [
            RULE,
            'Deploy?',
            '',
            ...['Yes', 'No', 'Other'].map((row, index) => `${index === this.cursor ? '❯' : ' '} ${index + 1}. ${row}`),
            RULE,
            '  4. Chat about this',
          ].join('\n');
    return {
      alive: true,
      dead: false,
      promptReady: this.mode === 'ready',
      activeWork: false,
      visible,
      history: visible,
    };
  }
  readonly harness = {
    form: {
      capture: async () => ({ ok: true, value: this.frame() }),
      key: async (key: string) => {
        this.keys.push(key);
        if (key === 'Down') this.cursor += 1;
        if (key === 'Up') this.cursor -= 1;
        if (key === 'Enter') this.mode = 'ready';
        return { ok: true, value: undefined };
      },
      paste: async (text: string) => {
        this.pastes.push(text);
        return { ok: true, value: undefined };
      },
    },
    transcript: { read: async () => [{ tools: { results: [] } }] },
  };
}

const ferretsOf = (panes: Record<string, Pane | undefined>) => ({
  get: async (id: string) => ({ id, state: 'idle', harness: 'claude-code' }),
  list: async () => Object.keys(panes).map(id => ({ id, harness: 'claude-code', state: 'idle' })),
  harness: async (id: string) => panes[id]?.harness,
});

const answerOn = (ferret: string, entry: string, values: Record<string, string>, text?: string) =>
  ({
    id: 'an_0123456789abcdef01234567',
    ferret,
    ask: 'A1',
    source: 'question',
    entry,
    effect: 'clarify',
    ...(text === undefined ? {} : { text }),
    values,
    by: { kind: 'host' },
    at: ASKED,
  }) as never;

describe("an answer on the Agenda is typed into the ferret's own question form", () => {
  test('the chosen option reaches the waiting form, and the card is left for the Agenda to resolve', async () => {
    const pane = new Pane();
    const w = world();
    const d = daemon({ ...w, ferrets: ferretsOf({ cody: pane }) });
    w.files.set('cody/question.json', FORM);
    await d.tick();
    expect(w.asks.open().map(item => item.draft.entry)).toEqual(['cody:t1']);

    const applied = await d.half.applyQuestionAnswer(answerOn('cody', 'cody:t1', { '1': 'No' }));

    expect(applied).toBe('applied');
    expect(pane.keys).toEqual(['Down', 'Enter']);
    expect(d.stored()).toBeUndefined();
    // The drive did not close the card: the Agenda records the answer and resolves it.
    expect(w.asks.open()).toHaveLength(1);
  });

  test("an answer to another ferret's question with the same tool id reaches that ferret only", async () => {
    const cody = new Pane();
    const rex = new Pane();
    const w = world();
    const d = daemon({ ...w, ferrets: ferretsOf({ cody, rex }) });
    w.files.set('cody/question.json', FORM);
    w.files.set('rex/question.json', FORM);

    const applied = await d.half.applyQuestionAnswer(answerOn('rex', 'rex:t1', { '1': 'Other' }));

    expect(applied).toBe('applied');
    expect(rex.keys).toEqual(['Down', 'Down', 'Enter']);
    expect(cody.keys).toEqual([]);
    expect(w.files.get('cody/question.json')).toBeDefined();
  });

  test('a failed delivery refuses in words, types nothing wrong and leaves the question to answer again', async () => {
    const w = world();
    // A ferret whose harness has no form to type into.
    const d = daemon({ ...w, ferrets: ferretsOf({ cody: undefined }) });
    w.files.set('cody/question.json', FORM);

    const applied = await d.half.applyQuestionAnswer(answerOn('cody', 'cody:t1', { '1': 'No' }));

    expect(applied).toEqual({ refused: expect.stringContaining('the question stays open') });
    expect(d.stored()).toBeDefined();
  });

  test('a question that no longer waits is refused, and nothing is typed', async () => {
    const pane = new Pane();
    const w = world();
    const d = daemon({ ...w, ferrets: ferretsOf({ cody: pane }) });
    w.files.set('cody/question.json', { ...FORM, toolUseId: 't2' });

    const applied = await d.half.applyQuestionAnswer(answerOn('cody', 'cody:t1', { '1': 'No' }));

    expect(applied).toEqual({ refused: expect.stringContaining('not waiting any more') });
    expect(pane.keys).toEqual([]);
  });
});

/** The events the daemon published, by name (a placeholder that keeps the assertion readable). */
const published = (d: { published: string[] }): string[] => d.published;

describe('a ferret parked on a permission prompt reaches the Agenda on the same watch tick', () => {
  const parkedOn = { current: undefined as unknown };
  const listing = { current: async (): Promise<unknown[]> => [{ id: 'cody', harness: 'claude', state: 'idle' }] };
  const withPrompt = () => {
    listing.current = async () => [{ id: 'cody', harness: 'claude', state: 'idle' }];
    const w = world();
    const ferrets = {
      get: async () => ({ id: 'cody', state: 'working' }),
      list: async () => listing.current(),
      prompt: async () => parkedOn.current,
    };
    return { w, d: daemon({ files: w.files, asks: w.asks, events: w.events, ferrets }) };
  };

  test('one card is raised for the prompt, however many ticks, and it is closed when the pane moves on', async () => {
    const { w, d } = withPrompt();
    parkedOn.current = {
      turnState: 'needs-input',
      permissionRequest: { id: '0123456789abcdef', tool: 'Bash', what: 'ls', question: 'Proceed?' },
    };
    await d.tick();
    await d.tick();
    expect(w.asks.open()).toHaveLength(1);
    expect(w.asks.open()[0]?.draft).toMatchObject({
      source: 'prompt',
      kind: 'task',
      ferret: 'cody',
      subject: 'cody needs a permission answer',
      context: 'Permission: Bash ls. Proceed?',
      blocking: true,
    });

    parkedOn.current = { turnState: 'working' };
    await d.tick();
    expect(w.asks.open()).toHaveLength(0);
    expect(w.asks.items[0]).toMatchObject({ state: 'closed', reason: 'withdrawn' });
  });

  test('an Asks that cannot take the card is said once, not on every tick, and the watch goes on', async () => {
    const { w, d } = withPrompt();
    parkedOn.current = {
      turnState: 'needs-input',
      permissionRequest: { id: '0123456789abcdef', tool: 'Bash', what: 'ls', question: 'Proceed?' },
    };
    w.asks.api.raise = async () => {
      throw new Error('asks is unavailable');
    };
    await d.tick();
    await d.tick();
    expect(d.warned.filter(line => line.includes('could not follow the prompt of cody'))).toHaveLength(1);
  });

  test('a ferret list that cannot be read is said once, not on every tick, and the watch goes on', async () => {
    const { d } = withPrompt();
    listing.current = async () => {
      throw new Error('ferrets is unavailable');
    };
    await d.tick();
    await d.tick();
    expect(d.warned.filter(line => line.includes('could not list the ferrets for their prompts'))).toHaveLength(1);
    listing.current = async () => [];
    await d.tick();
    listing.current = async () => {
      throw new Error('ferrets is unavailable');
    };
    await d.tick();
    expect(d.warned.filter(line => line.includes('could not list the ferrets for their prompts'))).toHaveLength(2);
  });
});
