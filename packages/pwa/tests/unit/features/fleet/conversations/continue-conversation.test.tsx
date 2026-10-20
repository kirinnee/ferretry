import { afterEach, describe, expect, it } from 'bun:test';
import {
  CONVERSATION_ADOPT_PATH,
  CONVERSATION_IMPORT_PATH,
  type ConversationPreview,
  type FleetRuntimeView,
  type ImportableConversation,
  type SessionView,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { z } from 'zod';
import { ContinueConversation } from '../../../../../src/features/fleet/conversations/continue-conversation.tsx';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';
import { sessionView } from '../../../../support/sessions.ts';
import { RUNTIMES, runtime, STUDIO } from '../account-support.ts';
import { conversation, listing, NOW, settle, type } from './conversation-support.ts';

const RUNTIMES_PATH = '/v1/fleet/runtimes';
const ALL = `${CONVERSATION_IMPORT_PATH}?source=ferretry&limit=50`;
const KEPT = `${CONVERSATION_IMPORT_PATH}?source=ferretry&limit=1000`;
const HOUR = 3_600_000;

interface Sent {
  readonly path: string;
  readonly body: unknown;
}

type Handler = (body: unknown, path: string) => unknown;

/** A listing path answers every search; the preview, runtimes and adopt paths answer as given. */
const machine = (
  routes: { list?: Handler; preview?: Handler; runtimes?: Handler; adopt?: Handler },
  sent: Sent[] = [],
): FleetClient => ({
  request: async <T,>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ path, body });
    const handler = path.startsWith(CONVERSATION_ADOPT_PATH)
      ? routes.adopt
      : path.endsWith('/preview')
        ? routes.preview
        : path.startsWith(CONVERSATION_IMPORT_PATH)
          ? routes.list
          : path === RUNTIMES_PATH
            ? routes.runtimes
            : undefined;
    if (handler === undefined) throw new Error(`no route ${path}`);
    const value = await handler(body, path);
    if (value instanceof Error) throw value;
    return schema.parse(value);
  },
});

const catalog = (runtimes: readonly FleetRuntimeView[]) => ({ ...RUNTIMES, runtimes });
const CLAUDE = runtime({ name: 'claude-default', wrapper: 'claude-default-w' });
const CODEX = runtime({ name: 'codex-default', harness: 'codex' });

const ROWS: readonly ImportableConversation[] = [
  conversation('shop-cart', { latest: 'and now the tests' }),
  conversation('api-codex', { harness: 'codex', project: '/work/api', model: undefined }),
  conversation('notes-kept', { project: '/work/notes', adoptedBy: 'notes-ferret' }),
];

const PREVIEW: ConversationPreview = {
  id: 'shop-cart',
  harness: 'claude',
  messages: [
    { role: 'user', text: 'Fix the cart total' },
    { role: 'assistant', text: 'Fixed the rounding.' },
  ],
};

const at = (hoursAgo: number): string => new Date(NOW - hoursAgo * HOUR).toISOString();
const SESSIONS: readonly SessionView[] = [
  sessionView('notes-ferret', {
    config: { name: 'notes', teammate: 'mika', cwd: '/work/notes' },
    state: { status: 'stopped', lastActivityAt: at(2) },
  }),
  sessionView('api-ferret', {
    config: { name: 'api', harness: 'codex', cwd: '/work/api' },
    state: { status: 'failed', lastActivityAt: at(30) },
  }),
  sessionView('live-ferret', { state: { status: 'running', lastActivityAt: at(1) } }),
];

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

interface OpenOptions {
  readonly list?: Handler;
  readonly preview?: Handler;
  readonly runtimes?: Handler;
  readonly adopt?: Handler;
  readonly sent?: Sent[];
  readonly navigated?: string[];
  readonly now?: boolean;
  /** Present adds the "Ferretry sessions" source. */
  readonly sessions?: readonly SessionView[] | null;
  readonly resumed?: string[];
  readonly resume?: (id: string) => Promise<void>;
}

const open = async (options: OpenOptions = {}): Promise<Mounted> => {
  const client = machine(
    {
      list: options.list ?? (() => listing(ROWS)),
      preview: options.preview ?? (() => PREVIEW),
      runtimes: options.runtimes ?? (() => catalog([CLAUDE, CODEX])),
      ...(options.adopt === undefined ? {} : { adopt: options.adopt }),
    },
    options.sent,
  );
  const resume =
    options.resume ??
    (async (id: string) => {
      options.resumed?.push(id);
    });
  view = await mount(
    <ContinueConversation
      connection={STUDIO}
      createClient={async () => client}
      onNavigate={path => options.navigated?.push(path)}
      {...(options.now === false ? {} : { now: () => NOW })}
      {...(options.sessions === undefined ? {} : { sessions: options.sessions, resume })}
      debounceMs={0}
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
  await settle();
};
const listed = (sent: readonly Sent[]): readonly string[] =>
  sent
    .filter(call => call.path.startsWith(CONVERSATION_IMPORT_PATH) && call.body === undefined)
    .filter(call => !call.path.endsWith('/preview'))
    .map(call => call.path);
const action = (key: string): string => `[data-continue-action="${key}"]`;
const SHOP = 'conversation:claude:shop-cart';

describe('ContinueConversation over all conversations', () => {
  it('heads a named conversation by its name and finds it by that name', async () => {
    await open({ list: () => listing([conversation('shop-cart', { name: 'Cart total bugfix', latest: 'ship it' })]) });
    const row = '[data-continue-row="shop-cart"]';
    expect(text(`${row} [data-conversation-name]`)).toBe('Cart total bugfix');
    expect(text(`${row} [data-conversation-first]`)).toBe('Fix the shop-cart page');
  });

  it('lists Ferretry’s own conversations: first message and age, the latest message, then its marks', async () => {
    const sent: Sent[] = [];
    await open({ sent });
    expect(listed(sent)).toEqual([ALL, KEPT]);
    expect(find('[data-segmented="source"] [data-segment="all"]').getAttribute('aria-pressed')).toBe('true');
    expect(text('[data-continue-count]')).toBe('3 conversations');
    const row = '[data-continue-row="shop-cart"]';
    expect(text(`${row} [data-conversation-age]`)).toBe('1d ago');
    expect(text(`${row} .fy-convo-title`)).toBe('Fix the shop-cart page');
    expect(text(`${row} [data-conversation-latest]`)).toBe('Latest: and now the tests');
    expect(text(`${row} [data-conversation-harness="claude"]`)).toBe('Claude');
    expect(text(`${row} [data-conversation-folder]`)).toBe('shop');
    expect(text(row)).toContain('4 turns · Sonnet 5.5');
    expect(find(row).getAttribute('aria-expanded')).toBe('false');
    expect(view?.container.querySelectorAll('[data-continue-row]')).toHaveLength(3);
    expect(view?.container.querySelector('[data-continue-row="api-codex"] [data-conversation-latest]')).toBeNull();
    expect(text('[data-continue-row="api-codex"] [data-conversation-harness="codex"]')).toBe('Codex');
    expect(text('[data-continue-row="api-codex"]')).not.toContain('Sonnet');
    expect(text('[data-continue-row="notes-kept"] [data-conversation-ferret="notes-ferret"]')).toBe(
      'Ferret notes-ferret',
    );
  });

  it('searches on the daemon with the words, the CLI and the date', async () => {
    const sent: Sent[] = [];
    await open({ sent });
    await type(find<HTMLInputElement>('[data-continue-search]'), ' shop tests ');
    await settle();
    await click('[data-segmented="source"] [data-segment="codex"]');
    await click('[data-segmented="date"] [data-segment="30d"]');
    expect(listed(sent).at(-1)).toBe(
      `${CONVERSATION_IMPORT_PATH}?source=ferretry&harness=codex&q=shop+tests&since=2026-09-13T08%3A00%3A00.000Z&limit=50`,
    );
  });

  it('says it is searching, and when nothing matches', async () => {
    const answers: ((value: unknown) => void)[] = [];
    await open({ list: () => new Promise(resolve => answers.push(resolve)) });
    expect(text('[data-continue-reading]')).toBe('Searching…');
    await interact(() => {
      for (const answer of answers) answer(listing([]));
    });
    await settle();
    expect(text('[data-continue-empty]')).toBe('No conversation matches.');
  });

  it('says how many matched when the limit cut the list, and one in the singular', async () => {
    await open({ list: () => listing([ROWS[0] as ImportableConversation], 120) });
    expect(text('[data-continue-count]')).toBe('1 conversation · newest 1 of 120');
    await view?.unmount();
    await open({ list: () => listing([ROWS[0] as ImportableConversation]) });
    expect(text('[data-continue-count]')).toBe('1 conversation');
  });

  it('shows a refused search’s sentence', async () => {
    await open({ list: () => new FyHttpError('Enter your passkey to search conversations.', 403, 'step_up') });
    expect(text('[data-continue-refused]')).toBe('Enter your passkey to search conversations.');
  });

  it('drops a search answer that lands after it left', async () => {
    let answer: (value: unknown) => void = () => undefined;
    let runtimesAnswer: (value: unknown) => void = () => undefined;
    await open({
      list: () => new Promise(resolve => (answer = resolve)),
      runtimes: () => new Promise(resolve => (runtimesAnswer = resolve)),
    });
    await view?.unmount();
    view = null;
    await interact(() => {
      answer(listing(ROWS));
      runtimesAnswer(catalog([]));
    });
    await settle();
  });

  it('works on the real clock', async () => {
    await open({ now: false });
    expect(text('[data-continue-count]')).toBe('3 conversations');
  });
});

describe('ContinueConversation preview', () => {
  it('opens a row on its last exchanges, read once, and closes it again', async () => {
    const sent: Sent[] = [];
    let answer: (value: unknown) => void = () => undefined;
    await open({ sent, preview: () => new Promise(resolve => (answer = resolve)) });
    await click('[data-continue-row="shop-cart"]');
    expect(find('[data-continue-row="shop-cart"]').getAttribute('aria-expanded')).toBe('true');
    expect(text(`[data-continue-preview="${SHOP}"]`)).toContain('Reading the last messages…');
    await interact(() => answer(PREVIEW));
    await settle();
    const exchanges = [...(view?.container.querySelectorAll('.fy-convo-exchange') ?? [])];
    expect(exchanges.map(item => [item.getAttribute('data-role'), item.textContent])).toEqual([
      ['user', 'YouFix the cart total'],
      ['assistant', 'AgentFixed the rounding.'],
    ]);
    expect(text(action(SHOP))).toBe('Continue');
    expect(sent.filter(call => call.path.endsWith('/preview')).map(call => call.path)).toEqual([
      `${CONVERSATION_IMPORT_PATH}/claude/shop-cart/preview`,
    ]);

    await click('[data-continue-row="shop-cart"]');
    expect(view?.container.querySelector(`[data-continue-preview="${SHOP}"]`)).toBeNull();
    await click('[data-continue-row="shop-cart"]');
    expect(sent.filter(call => call.path.endsWith('/preview'))).toHaveLength(1);
  });

  it('opens one row at a time, and says when a preview is refused or empty', async () => {
    await open({
      preview: (_body, path) =>
        path.includes('api-codex')
          ? { id: 'api-codex', harness: 'codex', messages: [] }
          : new FyHttpError('Enter your passkey to read it.', 403, 'step_up'),
    });
    await click('[data-continue-row="shop-cart"]');
    expect(text(`[data-continue-preview="${SHOP}"]`)).toContain('Enter your passkey to read it.');
    await click('[data-continue-row="api-codex"]');
    expect(view?.container.querySelector(`[data-continue-preview="${SHOP}"]`)).toBeNull();
    expect(text('[data-continue-preview="conversation:codex:api-codex"]')).toContain('Nothing was said in it yet.');
  });
});

describe('ContinueConversation continuing', () => {
  it('opens a running ferret that already keeps a conversation instead of making another', async () => {
    const navigated: string[] = [];
    const sent: Sent[] = [];
    await open({ navigated, sent });
    await click('[data-continue-row="notes-kept"]');
    expect(text(action('conversation:claude:notes-kept'))).toBe('Open ferret');
    await click(action('conversation:claude:notes-kept'));
    expect(navigated).toEqual(['/d/studio/session/notes-ferret']);
    expect(sent.some(call => call.path === CONVERSATION_ADOPT_PATH)).toBe(false);
  });

  it('resumes a stopped ferret that keeps a conversation, in place', async () => {
    const navigated: string[] = [];
    const resumed: string[] = [];
    await open({ navigated, resumed, sessions: SESSIONS });
    await click('[data-continue-row="notes-kept"]');
    expect(text(action('conversation:claude:notes-kept'))).toBe('Resume ferret');
    await click(action('conversation:claude:notes-kept'));
    expect(resumed).toEqual(['notes-ferret']);
    expect(navigated).toEqual(['/d/studio/session/notes-ferret']);
  });

  it('adopts on the only runtime with start on, then opens the new session', async () => {
    const navigated: string[] = [];
    const sent: Sent[] = [];
    let release: (value: unknown) => void = () => undefined;
    const gate = new Promise(resolve => (release = resolve));
    await open({
      navigated,
      sent,
      adopt: () =>
        gate.then(() => ({
          adopted: [{ id: 'shop-cart', session: 's-9', name: 'shop', status: 'running' }],
          refused: [],
        })),
    });
    await click('[data-continue-row="shop-cart"]');
    await click(action(SHOP));
    expect(text(action(SHOP))).toBe('Starting…');
    expect(find<HTMLButtonElement>('[data-continue-row="api-codex"]').disabled).toBe(true);
    await interact(() => release(undefined));
    await settle();
    expect(sent.find(call => call.path === CONVERSATION_ADOPT_PATH)?.body).toEqual({
      harness: 'claude',
      runtime: 'claude-default-w',
      conversations: [{ id: 'shop-cart', start: true }],
    });
    expect(navigated).toEqual(['/d/studio/session/s-9']);
  });

  it('asks which runtime when several drive the CLI', async () => {
    const navigated: string[] = [];
    const sent: Sent[] = [];
    const second = runtime({ name: 'claude-work' });
    await open({
      navigated,
      sent,
      runtimes: () => catalog([CLAUDE, second, CODEX]),
      adopt: () => ({ adopted: [{ id: 'shop-cart', session: 's-2', name: 'shop', status: 'running' }], refused: [] }),
    });
    await click('[data-continue-row="shop-cart"]');
    await click(action(SHOP));
    expect(text('[data-continue-runtimes="shop-cart"]')).toContain('Continue on which runtime?');
    await click('[data-continue-runtime="claude-work"]');
    expect(sent.find(call => call.path === CONVERSATION_ADOPT_PATH)?.body).toMatchObject({ runtime: 'claude-work' });
    expect(navigated).toEqual(['/d/studio/session/s-2']);
  });

  it('says when no runtime drives the conversation’s CLI', async () => {
    await open({ runtimes: () => catalog([CLAUDE]) });
    await click('[data-continue-row="api-codex"]');
    await click(action('conversation:codex:api-codex'));
    expect(text('[data-continue-issue="conversation:codex:api-codex"]')).toBe(
      'No Codex runtime on this machine yet. Add one in Settings › Runtimes, then try again.',
    );
  });

  it('reads no runtimes as none when the runtimes read is refused', async () => {
    await open({ runtimes: () => new FyHttpError('no', 403, 'forbidden') });
    await click('[data-continue-row="shop-cart"]');
    await click(action(SHOP));
    expect(text(`[data-continue-issue="${SHOP}"]`)).toContain('No Claude Code runtime');
  });

  it('shows a refused adoption’s sentence, the daemon’s reason, or a plain fallback', async () => {
    const adoptThen = async (adopt: Handler): Promise<string> => {
      await view?.unmount();
      await open({ adopt });
      await click('[data-continue-row="shop-cart"]');
      await click(action(SHOP));
      return text(`[data-continue-issue="${SHOP}"]`);
    };
    expect(await adoptThen(() => new FyHttpError('Only the owner may continue conversations.', 403, 'forbidden'))).toBe(
      'Only the owner may continue conversations.',
    );
    expect(
      await adoptThen(() => ({
        adopted: [],
        refused: [{ id: 'shop-cart', code: 'unavailable', reason: 'Its file is on another disk.' }],
      })),
    ).toBe('Its file is on another disk.');
    expect(await adoptThen(() => ({ adopted: [], refused: [] }))).toBe('This machine didn’t keep it.');
  });
});

describe('ContinueConversation marks and the Ferretry filter', () => {
  it('marks a conversation a ferret keeps with the ferret, its state and its CLI, under the conversation’s name', async () => {
    await open({
      sessions: SESSIONS,
      list: () =>
        listing([
          conversation('notes-kept', { project: '/work/notes', adoptedBy: 'notes-ferret', name: 'Notes cleanup' }),
        ]),
    });
    const row = '[data-continue-row="notes-kept"]';
    expect(text(`${row} [data-conversation-name]`)).toBe('Notes cleanup');
    expect(text(`${row} [data-conversation-first]`)).toBe('Fix the notes-kept page');
    expect(text(`${row} [data-conversation-ferret="notes-ferret"]`)).toBe('Ferret Mika · stopped');
    expect(text(`${row} [data-conversation-harness="claude"]`)).toBe('Claude');
    expect(find(`${row} .fy-convo-avatar__dot`).getAttribute('data-state')).toBe('stopped');
    expect(text(`${row} .fy-convo-avatar__initial`)).toBe('M');
  });

  it('lists the stopped ferrets the listing does not describe in every source that fits', async () => {
    await open({ sessions: SESSIONS });
    expect(text('[data-continue-count]')).toBe('4 conversations');
    const bare = '[data-continue-session="api-ferret"]';
    expect(text(`${bare} .fy-convo-title`)).toBe('api');
    expect(text(`${bare} [data-conversation-age]`)).toBe('1d ago');
    expect(text(`${bare} [data-conversation-ferret="api-ferret"]`)).toBe('Ferret api · failed');
    expect(text(`${bare} [data-conversation-harness="codex"]`)).toBe('Codex');
    expect(find(`${bare} .fy-convo-avatar__dot`).getAttribute('data-state')).toBe('failed');
    await click('[data-segmented="source"] [data-segment="claude"]');
    expect(view?.container.querySelector(bare)).toBeNull();
  });

  it('narrows Ferretry to what ferrets keep and the stopped ferrets, searching the ferret’s name too', async () => {
    const sent: Sent[] = [];
    await open({ sent, sessions: SESSIONS });
    await click('[data-segmented="source"] [data-segment="ferretry"]');
    expect(listed(sent)).toEqual([ALL, KEPT]);
    expect(text('[data-continue-count]')).toBe('2 conversations');
    const rows = [...(view?.container.querySelectorAll('[data-continue-row], [data-continue-session]') ?? [])];
    expect(rows.map(row => row.getAttribute('data-continue-row') ?? row.getAttribute('data-continue-session'))).toEqual(
      ['notes-kept', 'api-ferret'],
    );
    await type(find<HTMLInputElement>('[data-continue-search]'), 'mika');
    await settle();
    expect(text('[data-continue-count]')).toBe('1 conversation');
    await type(find<HTMLInputElement>('[data-continue-search]'), 'nothing like it');
    await settle();
    expect(text('[data-continue-empty]')).toBe('No conversation matches.');
  });

  it('resumes a bare stopped ferret in place, saying it has no preview and why a resume failed', async () => {
    const navigated: string[] = [];
    const resumed: string[] = [];
    const failures = [new Error('The pane would not open.'), new Error('')];
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => (release = resolve));
    await open({
      navigated,
      sessions: SESSIONS,
      resume: async id => {
        const failure = failures.shift();
        if (failure !== undefined) throw failure;
        await gate;
        resumed.push(id);
      },
    });
    await click('[data-continue-session="api-ferret"]');
    expect(find('[data-continue-session="api-ferret"]').closest('li')?.hasAttribute('data-open')).toBe(true);
    expect(text('[data-continue-preview="session:api-ferret"]')).toContain(
      'No preview of this ferret’s conversation is available.',
    );
    await click(action('session:api-ferret'));
    expect(text('[data-continue-issue="session:api-ferret"]')).toBe('The pane would not open.');
    await click(action('session:api-ferret'));
    expect(text('[data-continue-issue="session:api-ferret"]')).toBe('The ferret could not resume.');
    await click(action('session:api-ferret'));
    expect(text(action('session:api-ferret'))).toBe('Resuming…');
    await interact(() => release());
    await settle();
    expect(resumed).toEqual(['api-ferret']);
    expect(navigated).toEqual(['/d/studio/session/api-ferret']);
  });

  it('waits for the ferrets, lists them bare when the kept listing is refused, and says when Ferretry has none', async () => {
    await open({ sessions: null });
    expect(text('[data-continue-reading]')).toBe('Searching…');
    await view?.unmount();
    await open({ sessions: SESSIONS, list: () => new FyHttpError('no', 403, 'forbidden') });
    await click('[data-segmented="source"] [data-segment="ferretry"]');
    expect(text('[data-continue-session="notes-ferret"]')).toContain('Mika');
    await view?.unmount();
    await open({ sessions: [SESSIONS[2] as SessionView], list: () => listing([]) });
    await click('[data-segmented="source"] [data-segment="ferretry"]');
    expect(text('[data-continue-empty]')).toBe('No ferret keeps a conversation yet, and none is stopped.');
  });

  it('names a folder by its own name and marks a throwaway one scratch, never a hash path', async () => {
    await open({
      list: () =>
        listing([
          conversation('scratch-run', {
            project: '/tmp/claude-1000/-work-shop/d711c5af-2c1e-4b7a-9d3e-0f6a1b2c3d4e/scratchpad',
          }),
          conversation('worktree', { project: '/tmp/claude-1000/wt-cart', daysAgo: 2 }),
        ]),
    });
    const scratch = find('[data-continue-row="scratch-run"] [data-conversation-folder]');
    expect(scratch.getAttribute('data-conversation-folder')).toBe('scratch');
    expect(scratch.textContent).toBe('scratch');
    expect(scratch.getAttribute('title')).toContain('/scratchpad');
    expect(text('[data-continue-row="worktree"] [data-conversation-folder="scratch"]')).toBe('scratchwt-cart');
  });

  it('closes the open row when the source changes', async () => {
    await open({ sessions: SESSIONS });
    await click('[data-continue-row="shop-cart"]');
    expect(view?.container.querySelector('[data-continue-preview]')).not.toBeNull();
    await click('[data-segmented="source"] [data-segment="claude"]');
    expect(view?.container.querySelector('[data-continue-preview]')).toBeNull();
  });
});
