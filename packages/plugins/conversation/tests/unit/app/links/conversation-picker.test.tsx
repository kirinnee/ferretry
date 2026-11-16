import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import type { z } from 'zod';
import type { KeepResultSchema, LinkableConversation } from '../../../../contract/index.ts';
import {
  ConversationPicker,
  KeepConversations,
  noRuntimeSentence,
  type RuntimeField,
} from '../../../../app/links/conversation-picker.tsx';
import { type CallHandler, type FakeClient, fakeClient, refusal } from '../../../support/app/fake-client.ts';
import { conversation, listing, NOW, runtimeField, settle, type } from '../../../support/app/links.ts';

const LIST = 'GET /v1/links/conversations';
/** A keep answer as the daemon sends it. */
type KeepAnswer = z.input<typeof KeepResultSchema>;
const KEEP = 'POST /v1/links/conversations/keep';

/** The listing route, answered per CLI; a CLI with no answer is an unreachable machine. */
const byHarness =
  (answers: Readonly<Record<string, CallHandler>>): CallHandler =>
  call => {
    const answer = answers[call.query.harness ?? ''];
    if (answer === undefined) throw new Error(`no listing for ${call.query.harness ?? '(none)'}`);
    return answer(call);
  };

const ROWS: readonly LinkableConversation[] = [
  conversation('shop-cart', { daysAgo: 1, latest: 'and the tests' }),
  conversation('shop-old', { daysAgo: 12, turns: 1 }),
  conversation('notes-day', { project: '/work/notes', daysAgo: 0.5, preview: 'Tidy the notes', model: undefined }),
  conversation('notes-kept', { project: '/work/notes', daysAgo: 3, keptBy: 'notes-ferret' }),
];

/** The runtime slot as Runtimes fills it here: one Claude Code runtime. */
const CLAUDE = runtimeField({ 'claude-code': ['claude-default'] });

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

interface OpenOptions {
  readonly routes?: Record<string, CallHandler>;
  readonly runtimeField?: RuntimeField;
  readonly runtime?: string;
}

let client: FakeClient = fakeClient();

const open = async (options: OpenOptions = {}): Promise<Mounted> => {
  client = fakeClient(options.routes ?? { [LIST]: () => listing(ROWS) });
  view = await mount(
    <ConversationPicker
      client={client}
      harness="claude-code"
      runtimeField={options.runtimeField ?? CLAUDE}
      {...(options.runtime === undefined ? {} : { runtime: options.runtime })}
      now={() => NOW}
    />,
  );
  await settle();
  return view;
};
const sentKeep = (): unknown => client.callsTo(KEEP)[0]?.body;
/** Picks a runtime in the slot’s stand-in. */
const pick = (wrapper: string): Promise<void> => click(`[data-test-runtime="${wrapper}"]`);

const find = <T extends Element = HTMLElement>(selector: string): T =>
  must(view?.container.querySelector<T>(selector), selector);
const text = (selector: string): string => find(selector).textContent ?? '';
const click = async (selector: string): Promise<void> => {
  const element = find(selector);
  await interact(() => element.click());
};
const all = (selector: string): readonly Element[] => [...(view?.container.querySelectorAll(selector) ?? [])];

describe('ConversationPicker states', () => {
  it('says it is looking while the listing is read', async () => {
    await open({ routes: { [LIST]: () => new Promise(() => undefined) } });
    expect(text('[data-conversations-reading]')).toBe('Looking for Claude Code conversations…');
  });

  it('shows a refusal with its sentence, and reads again on Try again', async () => {
    let calls = 0;
    await open({
      routes: {
        [LIST]: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(refusal(403, 'step_up', 'Enter your passkey to read conversations.'))
            : listing(ROWS);
        },
      },
    });
    expect(text('[data-setup-note="conversations-refused"]')).toContain('Enter your passkey to read conversations.');
    await click('[data-conversations-retry]');
    await settle();
    expect(text('[data-conversations-found]')).toBe('Found 4 conversations · 1 already kept');
  });

  it('says so when this machine has none', async () => {
    await open({ routes: { [LIST]: () => listing([]) } });
    expect(text('[data-setup-note="conversations-empty"]')).toBe('No Claude Code conversations on this machine.');
  });
});

describe('ConversationPicker rows', () => {
  it('lists rows newest first in one container, with nothing ticked and kept rows disabled', async () => {
    await open();
    expect(all('[data-conversation-list]')).toHaveLength(1);
    expect(all('[data-conversation-row]').map(row => row.getAttribute('data-conversation-row'))).toEqual([
      'notes-day',
      'shop-cart',
      'notes-kept',
      'shop-old',
    ]);
    expect(all('input[type="checkbox"]:checked')).toHaveLength(0);
    expect(find<HTMLInputElement>('[data-conversation-keep="notes-kept"]').disabled).toBe(true);
    expect(text('[data-conversation-kept="notes-ferret"] [data-conversation-ferret]')).toBe('Ferret notes-ferret');
    expect(text('[data-conversation-row="shop-cart"]')).toContain(
      'Fix the shop-cart page1d agoLatest: and the testsClaudeshop4 turns · Sonnet 5.5',
    );
    expect(text('[data-conversation-row="shop-old"]')).toContain('1 turn ·');
    expect(text('[data-conversation-row="notes-day"]')).not.toContain('Haiku');
    expect(find<HTMLButtonElement>('[data-conversations-keep]').disabled).toBe(true);
    expect(text('[data-conversations-keep]')).toBe('Keep 0 as ferrets');
    expect(view?.container.querySelector('[data-conversations-show-all]')).toBeNull();
  });

  it('keeps a row, offers Start now on it, and forgets Start now when unkept', async () => {
    await open();
    const box = find<HTMLInputElement>('[data-conversation-keep="shop-cart"]');
    await interact(() => box.click());
    expect(text('[data-conversations-keep]')).toBe('Keep 1 as a ferret');
    expect(find('[data-conversation-start="shop-cart"]').getAttribute('aria-checked')).toBe('false');
    await click('[data-conversation-start="shop-cart"]');
    expect(find('[data-conversation-start="shop-cart"]').getAttribute('aria-checked')).toBe('true');
    await click('[data-conversation-start="shop-cart"]');
    expect(find('[data-conversation-start="shop-cart"]').getAttribute('aria-checked')).toBe('false');
    await click('[data-conversation-start="shop-cart"]');
    await interact(() => box.click());
    expect(view?.container.querySelector('[data-conversation-start]')).toBeNull();
    expect(text('[data-conversations-keep]')).toBe('Keep 0 as ferrets');
  });

  it('disables Start now on the eleventh kept row', async () => {
    const rows = Array.from({ length: 11 }, (_, index) => conversation(`c${index}`, { daysAgo: 1 + index / 100 }));
    await open({ routes: { [LIST]: () => listing(rows) } });
    await click('[data-conversations-last-week]');
    for (let index = 0; index < 10; index += 1) await click(`[data-conversation-start="c${index}"]`);
    expect(find<HTMLButtonElement>('[data-conversation-start="c10"]').disabled).toBe(true);
    expect(find<HTMLButtonElement>('[data-conversation-start="c0"]').disabled).toBe(false);
  });

  it('Select last 7 days keeps the fresh rows and skips the kept one', async () => {
    await open();
    await click('[data-conversations-last-week]');
    expect(all('input[type="checkbox"]:checked').map(box => box.getAttribute('data-conversation-keep'))).toEqual([
      'notes-day',
      'shop-cart',
    ]);
  });

  it('searches messages and folders, and filters by date', async () => {
    await open();
    await type(find<HTMLInputElement>('[data-conversations-search]'), 'TESTS');
    expect(all('[data-conversation-row]').map(row => row.getAttribute('data-conversation-row'))).toEqual(['shop-cart']);
    await type(find<HTMLInputElement>('[data-conversations-search]'), 'nothing like it');
    expect(text('[data-conversations-no-match]')).toBe('No conversation matches.');
    await type(find<HTMLInputElement>('[data-conversations-search]'), '');
    await click('[data-segmented="date"] [data-segment="7d"]');
    expect(find('[data-segment="7d"]').getAttribute('aria-pressed')).toBe('true');
    expect(all('[data-conversation-row]')).toHaveLength(3);
  });

  it('shows the 20 most recent until Show all, and back', async () => {
    const rows = Array.from({ length: 22 }, (_, index) => conversation(`c${index}`, { daysAgo: index + 1 }));
    await open({ routes: { [LIST]: () => listing(rows) } });
    expect(all('[data-conversation-row]')).toHaveLength(20);
    await click('[data-conversations-show-all]');
    expect(all('[data-conversation-row]')).toHaveLength(22);
    expect(text('[data-conversations-show-all]')).toBe('Show recent 20');
    await click('[data-conversations-show-all]');
    expect(all('[data-conversation-row]')).toHaveLength(20);
  });

  it('heads a named conversation by its name, with the first message under it and no latest line', async () => {
    await open({
      routes: {
        [LIST]: () =>
          listing([
            conversation('named', { name: 'Cart total bugfix', latest: 'ship it' }),
            conversation('plain', { latest: 'and the tests' }),
          ]),
      },
    });
    expect(text('[data-conversation-row="named"] [data-conversation-name]')).toBe('Cart total bugfix');
    expect(text('[data-conversation-row="named"] [data-conversation-first]')).toBe('Fix the named page');
    expect(all('[data-conversation-row="named"] [data-conversation-latest]')).toHaveLength(0);
    expect(all('[data-conversation-row="plain"] [data-conversation-name]')).toHaveLength(0);
    expect(all('[data-conversation-row="plain"] [data-conversation-first]')).toHaveLength(0);
    expect(text('[data-conversation-row="plain"] [data-conversation-latest]')).toContain('and the tests');
  });
});

describe('ConversationPicker runtime and keep', () => {
  const RESULT: KeepAnswer = {
    kept: [{ id: 'shop-cart', ferret: 's-1', name: 'shop-cart-ferret', state: 'stopped' }],
    refused: [{ id: 'notes-day', code: 'conflict', reason: 'The runtime already holds a different file.' }],
  };

  it('keeps the picked rows on the runtime picked, reports what it did, and reads again', async () => {
    let release: (value: unknown) => void = () => undefined;
    const pending = new Promise(resolve => {
      release = resolve;
    });
    let reads = 0;
    await open({
      routes: {
        [LIST]: () => {
          reads += 1;
          return listing(ROWS);
        },
        [KEEP]: () => pending.then(() => RESULT),
      },
    });
    await click('[data-conversations-last-week]');
    await click('[data-conversation-start="shop-cart"]');
    expect(find<HTMLButtonElement>('[data-conversations-keep]').disabled).toBe(true);
    await pick('claude-default');
    expect(find<HTMLButtonElement>('[data-conversations-keep]').disabled).toBe(false);
    await click('[data-conversations-keep]');
    expect(text('[data-conversations-keep]')).toBe('Keeping…');
    await interact(() => release(undefined));
    await settle();
    expect(sentKeep()).toEqual({
      harness: 'claude-code',
      runtime: 'claude-default',
      conversations: [
        { id: 'shop-cart', start: true },
        { id: 'notes-day', start: false },
      ],
    });
    expect(text('[data-setup-note="conversations-result"]')).toContain('Kept 1 as a ferret');
    expect(text('[data-conversations-kept]')).toBe('shop-cart-ferret · stopped');
    expect(text('[data-conversations-refused]')).toBe('notes-day: The runtime already holds a different file.');
    expect(find('[data-setup-note="conversations-result"]').getAttribute('data-tone')).toBe('warn');
    expect(reads).toBe(2);
    expect(all('input[type="checkbox"]:checked')).toHaveLength(0);
  });

  it('reports a clean keep in the ok tone, plural', async () => {
    const two: KeepAnswer = {
      kept: [
        { id: 'shop-cart', ferret: 's-1', name: 'one', state: 'stopped' },
        { id: 'shop-old', ferret: 's-2', name: 'two', state: 'stopped' },
      ],
      refused: [],
    };
    await open({ routes: { [LIST]: () => listing(ROWS), [KEEP]: () => two } });
    await click('[data-conversation-keep="shop-cart"]');
    await pick('claude-default');
    await click('[data-conversations-keep]');
    await settle();
    expect(find('[data-setup-note="conversations-result"]').getAttribute('data-tone')).toBe('ok');
    expect(text('[data-setup-note="conversations-result"]')).toContain('Kept 2 as ferrets');
    expect(view?.container.querySelector('[data-conversations-refused]')).toBeNull();
  });

  it('reports nothing kept without an empty list', async () => {
    const none: KeepAnswer = {
      kept: [],
      refused: [{ id: 'shop-cart', code: 'failed', reason: 'It could not be created.' }],
    };
    await open({ routes: { [LIST]: () => listing(ROWS), [KEEP]: () => none } });
    await click('[data-conversation-keep="shop-cart"]');
    await pick('claude-default');
    await click('[data-conversations-keep]');
    await settle();
    expect(view?.container.querySelector('[data-conversations-kept]')).toBeNull();
    expect(text('[data-conversations-refused]')).toBe('shop-cart: It could not be created.');
  });

  it('shows a refused keep’s sentence and keeps the selection', async () => {
    await open({
      routes: {
        [LIST]: () => listing(ROWS),
        [KEEP]: () => {
          throw refusal(403, 'forbidden', 'Only the owner may keep conversations.');
        },
      },
    });
    await click('[data-conversation-keep="shop-cart"]');
    await pick('claude-default');
    await click('[data-conversations-keep]');
    await settle();
    expect(text('[data-conversations-issue]')).toBe('Only the owner may keep conversations.');
    expect(text('[data-conversations-keep]')).toBe('Keep 1 as a ferret');
  });

  it('asks which runtime of this CLI, and sends the one picked', async () => {
    await open({
      runtimeField: runtimeField({
        'claude-code': ['claude-default', 'claude-work-wrapper'],
        codex: ['codex-default'],
      }),
      routes: { [LIST]: () => listing(ROWS), [KEEP]: () => ({ kept: [], refused: [] }) },
    });
    await click('[data-conversation-keep="shop-cart"]');
    expect(all('[data-test-runtimes="claude-code"] [data-test-runtime]').map(item => item.textContent)).toEqual([
      'claude-default',
      'claude-work-wrapper',
    ]);
    expect(find<HTMLButtonElement>('[data-conversations-keep]').disabled).toBe(true);
    await pick('claude-work-wrapper');
    await click('[data-conversations-keep]');
    await settle();
    expect(sentKeep()).toMatchObject({
      runtime: 'claude-work-wrapper',
    });
  });

  it('says when no runtime drives the CLI', async () => {
    await open({ runtimeField: runtimeField({}) });
    expect(text('[data-conversations-no-runtime]')).toBe(
      'No Claude Code runtime on this machine yet. Add one in Settings › Runtimes, then try again.',
    );
    expect(noRuntimeSentence('codex')).toBe(
      'No Codex runtime on this machine yet. Add one in Settings › Runtimes, then try again.',
    );
    await click('[data-conversation-keep="shop-cart"]');
    expect(find<HTMLButtonElement>('[data-conversations-keep]').disabled).toBe(true);
  });

  it('uses a runtime it was handed without asking', async () => {
    await open({ runtime: 'claude-given', runtimeField: runtimeField({}) });
    expect(view?.container.querySelector('[data-conversations-no-runtime]')).toBeNull();
    expect(view?.container.querySelector('[data-conversations-runtime]')).toBeNull();
    await click('[data-conversation-keep="shop-cart"]');
    expect(find<HTMLButtonElement>('[data-conversations-keep]').disabled).toBe(false);
  });
});

describe('KeepConversations', () => {
  it('switches CLI, reading that CLI’s conversations', async () => {
    const keepClient = fakeClient({
      [LIST]: byHarness({
        'claude-code': () => listing(ROWS),
        codex: () => listing([conversation('codex-one', { harness: 'codex', project: '/work/api' })]),
      }),
    });
    view = await mount(<KeepConversations client={keepClient} runtimeField={CLAUDE} now={() => NOW} />);
    await settle();
    expect(text('[data-conversation-picker]')).toContain('Found 4 conversations');
    await click('[data-segmented="harness"] [data-segment="codex"]');
    await settle();
    expect(find('[data-conversation-picker]').getAttribute('data-conversation-picker')).toBe('codex');
    expect(text('[data-conversations-found]')).toBe('Found 1 conversation');
    expect(text('[data-conversations-no-runtime]')).toContain('No Codex runtime');
    expect(keepClient.callsTo(LIST).map(call => call.query)).toEqual([
      { harness: 'claude-code', limit: '5000' },
      { harness: 'codex', limit: '5000' },
    ]);
  });

  it('defaults its clock when none is handed in', async () => {
    const keepClient = fakeClient({ [LIST]: () => listing([]) });
    view = await mount(<KeepConversations client={keepClient} runtimeField={runtimeField({})} />);
    await settle();
    expect(text('[data-setup-note="conversations-empty"]')).toBe('No Claude Code conversations on this machine.');
  });
});
