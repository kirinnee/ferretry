import { afterEach, describe, expect, it } from 'bun:test';
import {
  CONVERSATION_ADOPT_PATH,
  CONVERSATION_IMPORT_PATH,
  type ConversationAdoptResult,
  type FleetRuntimeView,
  type ImportableConversation,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { z } from 'zod';
import {
  ConversationPicker,
  ImportConversations,
  previewText,
} from '../../../../../src/features/fleet/conversations/conversation-picker.tsx';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';
import { runtime, STUDIO } from '../account-support.ts';
import { conversation, listing, NOW, settle, type } from './conversation-support.ts';

const CLAUDE_LIST = `${CONVERSATION_IMPORT_PATH}?harness=claude&limit=5000`;
const CODEX_LIST = `${CONVERSATION_IMPORT_PATH}?harness=codex&limit=5000`;

interface Sent {
  readonly path: string;
  readonly body: unknown;
}

type Handler = (body: unknown) => unknown;

/** A machine answering `path → handler`, which may be async; a missing route is an unreachable machine. */
const machine = (routes: Record<string, Handler>, sent: Sent[] = []): FleetClient => ({
  request: async <T,>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ path, body });
    const handler = routes[path];
    if (handler === undefined) throw new Error(`no route ${path}`);
    const value = await handler(body);
    if (value instanceof Error) throw value;
    return schema.parse(value);
  },
});

const ROWS: readonly ImportableConversation[] = [
  conversation('shop-cart', { daysAgo: 1, latest: 'and the tests' }),
  conversation('shop-old', { daysAgo: 12, turns: 1 }),
  conversation('notes-day', { project: '/work/notes', daysAgo: 0.5, preview: 'Tidy the notes', model: undefined }),
  conversation('notes-kept', { project: '/work/notes', daysAgo: 3, adoptedBy: 'notes-ferret' }),
];

const CLAUDE = runtime({ name: 'claude-default' });

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

interface OpenOptions {
  readonly routes?: Record<string, Handler>;
  readonly runtimes?: readonly FleetRuntimeView[];
  readonly runtime?: string;
  readonly sent?: Sent[];
  readonly createClient?: () => Promise<FleetClient>;
}

const open = async (options: OpenOptions = {}): Promise<Mounted> => {
  const client = machine(options.routes ?? { [CLAUDE_LIST]: () => listing(ROWS) }, options.sent);
  view = await mount(
    <ConversationPicker
      connection={STUDIO}
      createClient={options.createClient ?? (async () => client)}
      harness="claude"
      runtimes={options.runtimes ?? [CLAUDE]}
      {...(options.runtime === undefined ? {} : { runtime: options.runtime })}
      now={() => NOW}
    />,
  );
  await settle();
  return view;
};

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
    await open({ createClient: () => new Promise(() => undefined) });
    expect(text('[data-conversations-reading]')).toBe('Looking for Claude Code conversations…');
  });

  it('shows a refusal with its sentence, and reads again on Try again', async () => {
    let calls = 0;
    await open({
      routes: {
        [CLAUDE_LIST]: () => {
          calls += 1;
          return calls === 1
            ? new FyHttpError('Enter your passkey to read conversations.', 403, 'step_up')
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
    await open({ routes: { [CLAUDE_LIST]: () => listing([]) } });
    expect(text('[data-setup-note="conversations-empty"]')).toBe('No Claude Code conversations on this machine.');
  });
});

describe('ConversationPicker rows', () => {
  it('lists rows newest first in one container, with nothing ticked and adopted rows disabled', async () => {
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
    expect(text('[data-conversation-adopted="notes-ferret"]')).toBe('Kept as notes-ferret');
    expect(text('[data-conversation-row="shop-cart"]')).toContain(
      'Fix the shop-cart page1d agoLatest: and the testswork/shop· Claude · 4 turns· Sonnet 5.5',
    );
    expect(text('[data-conversation-row="shop-old"]')).toContain('· 1 turn');
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
    await open({ routes: { [CLAUDE_LIST]: () => listing(rows) } });
    await click('[data-conversations-last-week]');
    for (let index = 0; index < 10; index += 1) await click(`[data-conversation-start="c${index}"]`);
    expect(find<HTMLButtonElement>('[data-conversation-start="c10"]').disabled).toBe(true);
    expect(find<HTMLButtonElement>('[data-conversation-start="c0"]').disabled).toBe(false);
  });

  it('Select last 7 days keeps the fresh rows and skips the adopted one', async () => {
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
    await open({ routes: { [CLAUDE_LIST]: () => listing(rows) } });
    expect(all('[data-conversation-row]')).toHaveLength(20);
    await click('[data-conversations-show-all]');
    expect(all('[data-conversation-row]')).toHaveLength(22);
    expect(text('[data-conversations-show-all]')).toBe('Show recent 20');
    await click('[data-conversations-show-all]');
    expect(all('[data-conversation-row]')).toHaveLength(20);
  });

  it('reads an empty preview as such', () => {
    expect(previewText(conversation('x', { preview: '  ' }))).toBe('No message preview');
  });
});

describe('ConversationPicker runtime and adoption', () => {
  const RESULT: ConversationAdoptResult = {
    adopted: [{ id: 'shop-cart', session: 's-1', name: 'shop-cart-ferret', status: 'rate_limited' }],
    refused: [{ id: 'notes-day', code: 'conflict', reason: 'The runtime already holds a different file.' }],
  };

  it('adopts the kept rows on the only runtime, reports what it did, and reads again', async () => {
    const sent: Sent[] = [];
    let release: (value: unknown) => void = () => undefined;
    const pending = new Promise(resolve => {
      release = resolve;
    });
    let reads = 0;
    await open({
      sent,
      routes: {
        [CLAUDE_LIST]: () => {
          reads += 1;
          return listing(ROWS);
        },
        [CONVERSATION_ADOPT_PATH]: () => pending.then(() => RESULT),
      },
    });
    await click('[data-conversations-last-week]');
    await click('[data-conversation-start="shop-cart"]');
    await click('[data-conversations-keep]');
    expect(text('[data-conversations-keep]')).toBe('Keeping…');
    await interact(() => release(undefined));
    await settle();
    expect(sent.find(call => call.path === CONVERSATION_ADOPT_PATH)?.body).toEqual({
      harness: 'claude',
      runtime: 'claude-default',
      conversations: [
        { id: 'shop-cart', start: true },
        { id: 'notes-day', start: false },
      ],
    });
    expect(text('[data-setup-note="conversations-result"]')).toContain('Kept 1 as a ferret');
    expect(text('[data-conversations-adopted]')).toBe('shop-cart-ferret · rate limited');
    expect(text('[data-conversations-refused]')).toBe('notes-day: The runtime already holds a different file.');
    expect(find('[data-setup-note="conversations-result"]').getAttribute('data-tone')).toBe('warn');
    expect(reads).toBe(2);
    expect(all('input[type="checkbox"]:checked')).toHaveLength(0);
  });

  it('reports a clean adoption in the ok tone, plural', async () => {
    const two: ConversationAdoptResult = {
      adopted: [
        { id: 'shop-cart', session: 's-1', name: 'one', status: 'stopped' },
        { id: 'shop-old', session: 's-2', name: 'two', status: 'stopped' },
      ],
      refused: [],
    };
    await open({ routes: { [CLAUDE_LIST]: () => listing(ROWS), [CONVERSATION_ADOPT_PATH]: () => two } });
    await click('[data-conversation-keep="shop-cart"]');
    await click('[data-conversations-keep]');
    await settle();
    expect(find('[data-setup-note="conversations-result"]').getAttribute('data-tone')).toBe('ok');
    expect(text('[data-setup-note="conversations-result"]')).toContain('Kept 2 as ferrets');
    expect(view?.container.querySelector('[data-conversations-refused]')).toBeNull();
  });

  it('reports nothing adopted without an empty list', async () => {
    const none: ConversationAdoptResult = {
      adopted: [],
      refused: [{ id: 'shop-cart', code: 'failed', reason: 'It could not be created.' }],
    };
    await open({ routes: { [CLAUDE_LIST]: () => listing(ROWS), [CONVERSATION_ADOPT_PATH]: () => none } });
    await click('[data-conversation-keep="shop-cart"]');
    await click('[data-conversations-keep]');
    await settle();
    expect(view?.container.querySelector('[data-conversations-adopted]')).toBeNull();
    expect(text('[data-conversations-refused]')).toBe('shop-cart: It could not be created.');
  });

  it('shows a refused adoption’s sentence and keeps the selection', async () => {
    await open({
      routes: {
        [CLAUDE_LIST]: () => listing(ROWS),
        [CONVERSATION_ADOPT_PATH]: () => new FyHttpError('Only the owner may keep conversations.', 403, 'forbidden'),
      },
    });
    await click('[data-conversation-keep="shop-cart"]');
    await click('[data-conversations-keep]');
    await settle();
    expect(text('[data-conversations-issue]')).toBe('Only the owner may keep conversations.');
    expect(text('[data-conversations-keep]')).toBe('Keep 1 as a ferret');
  });

  it('asks which runtime when several drive the CLI, and sends the one picked', async () => {
    const sent: Sent[] = [];
    const work = runtime({ name: 'claude-work', wrapper: 'claude-work-wrapper' });
    await open({
      sent,
      runtimes: [CLAUDE, work, runtime({ name: 'codex-default', harness: 'codex' })],
      routes: { [CLAUDE_LIST]: () => listing(ROWS), [CONVERSATION_ADOPT_PATH]: () => ({ adopted: [], refused: [] }) },
    });
    await click('[data-conversation-keep="shop-cart"]');
    expect(all('[data-segmented="runtime"] [data-segment]').map(item => item.textContent)).toEqual([
      'claude-default',
      'claude-work',
    ]);
    expect(find<HTMLButtonElement>('[data-conversations-keep]').disabled).toBe(true);
    await click('[data-segment="claude-work-wrapper"]');
    await click('[data-conversations-keep]');
    await settle();
    expect(sent.find(call => call.path === CONVERSATION_ADOPT_PATH)?.body).toMatchObject({
      runtime: 'claude-work-wrapper',
    });
  });

  it('says when no runtime drives the CLI', async () => {
    await open({ runtimes: [] });
    expect(text('[data-conversations-no-runtime]')).toBe(
      'No Claude Code runtime on this machine yet. Add one in Settings › Runtimes, then try again.',
    );
    await click('[data-conversation-keep="shop-cart"]');
    expect(find<HTMLButtonElement>('[data-conversations-keep]').disabled).toBe(true);
  });

  it('uses a runtime it was handed without asking', async () => {
    await open({ runtime: 'claude-given', runtimes: [] });
    expect(view?.container.querySelector('[data-conversations-no-runtime]')).toBeNull();
    expect(view?.container.querySelector('[data-segmented="runtime"]')).toBeNull();
    await click('[data-conversation-keep="shop-cart"]');
    expect(find<HTMLButtonElement>('[data-conversations-keep]').disabled).toBe(false);
  });
});

describe('ImportConversations', () => {
  it('switches CLI, reading that CLI’s conversations, and goes back', async () => {
    let back = 0;
    const client = machine({
      [CLAUDE_LIST]: () => listing(ROWS),
      [CODEX_LIST]: () => listing([conversation('codex-one', { harness: 'codex', project: '/work/api' })]),
    });
    view = await mount(
      <ImportConversations
        connection={STUDIO}
        createClient={async () => client}
        runtimes={[CLAUDE]}
        onBack={() => {
          back += 1;
        }}
        now={() => NOW}
      />,
    );
    await settle();
    expect(text('[data-conversation-picker]')).toContain('Found 4 conversations');
    await click('[data-segmented="harness"] [data-segment="codex"]');
    await settle();
    expect(find('[data-conversation-picker]').getAttribute('data-conversation-picker')).toBe('codex');
    expect(text('[data-conversations-found]')).toBe('Found 1 conversation');
    expect(text('[data-conversations-no-runtime]')).toContain('No Codex runtime');
    await click('[data-page-back]');
    expect(back).toBe(1);
  });

  it('defaults its clock when none is handed in', async () => {
    const client = machine({ [CLAUDE_LIST]: () => listing([]) });
    view = await mount(
      <ImportConversations
        connection={STUDIO}
        createClient={async () => client}
        runtimes={[]}
        onBack={() => undefined}
      />,
    );
    await settle();
    expect(text('[data-setup-note="conversations-empty"]')).toBe('No Claude Code conversations on this machine.');
  });
});
