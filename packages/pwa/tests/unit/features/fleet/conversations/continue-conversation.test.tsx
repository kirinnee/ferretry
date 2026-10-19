import { afterEach, describe, expect, it } from 'bun:test';
import {
  CONVERSATION_ADOPT_PATH,
  CONVERSATION_IMPORT_PATH,
  type FleetRuntimeView,
  type ImportableConversation,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { z } from 'zod';
import { ContinueConversation } from '../../../../../src/features/fleet/conversations/continue-conversation.tsx';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';
import { RUNTIMES, runtime, STUDIO } from '../account-support.ts';
import { conversation, listing, NOW, settle, type } from './conversation-support.ts';

const RUNTIMES_PATH = '/v1/fleet/runtimes';
const ALL = `${CONVERSATION_IMPORT_PATH}?limit=50`;

interface Sent {
  readonly path: string;
  readonly body: unknown;
}

type Handler = (body: unknown) => unknown;

/** A listing path answers every search; the runtimes and adopt paths answer as given. */
const machine = (routes: { list?: Handler; runtimes?: Handler; adopt?: Handler }, sent: Sent[] = []): FleetClient => ({
  request: async <T,>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ path, body });
    const handler = path.startsWith(CONVERSATION_ADOPT_PATH)
      ? routes.adopt
      : path.startsWith(CONVERSATION_IMPORT_PATH)
        ? routes.list
        : path === RUNTIMES_PATH
          ? routes.runtimes
          : undefined;
    if (handler === undefined) throw new Error(`no route ${path}`);
    const value = await handler(body);
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

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

interface OpenOptions {
  readonly list?: Handler;
  readonly runtimes?: Handler;
  readonly adopt?: Handler;
  readonly sent?: Sent[];
  readonly navigated?: string[];
  readonly now?: boolean;
}

const open = async (options: OpenOptions = {}): Promise<Mounted> => {
  const client = machine(
    {
      list: options.list ?? (() => listing(ROWS)),
      runtimes: options.runtimes ?? (() => catalog([CLAUDE, CODEX])),
      ...(options.adopt === undefined ? {} : { adopt: options.adopt }),
    },
    options.sent,
  );
  view = await mount(
    <ContinueConversation
      connection={STUDIO}
      createClient={async () => client}
      onNavigate={path => options.navigated?.push(path)}
      {...(options.now === false ? {} : { now: () => NOW })}
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
  sent.filter(call => call.path.startsWith(CONVERSATION_IMPORT_PATH) && call.body === undefined).map(call => call.path);

describe('ContinueConversation search', () => {
  it('lists the most recent conversations as two-line rows: preview and age, then folder, CLI, turns and model', async () => {
    const sent: Sent[] = [];
    await open({ sent });
    expect(listed(sent)).toEqual([ALL]);
    expect(text('[data-continue-count]')).toBe('3 matches');
    const row = text('[data-continue-row="shop-cart"]');
    expect(row).toContain('Fix the shop-cart page1d ago');
    expect(row).toContain('work/shop· Claude · 4 turns· Sonnet 5.5');
    expect(row).toContain('Continue');
    expect(find('[data-continue-row="shop-cart"] [title="and now the tests"]').textContent).toBe(
      'Fix the shop-cart page',
    );
    expect(view?.container.querySelectorAll('[data-continue-row]')).toHaveLength(3);
    expect(text('[data-continue-row="api-codex"]')).toContain('· Codex ·');
    expect(text('[data-continue-row="api-codex"]')).not.toContain('Sonnet');
    expect(text('[data-continue-row="notes-kept"]')).toContain('Open notes-ferret');
  });

  it('searches on the daemon with the words, the CLI and the date', async () => {
    const sent: Sent[] = [];
    await open({ sent });
    await type(find<HTMLInputElement>('[data-continue-search]'), ' shop tests ');
    await settle();
    await click('[data-segmented="harness"] [data-segment="codex"]');
    await click('[data-segmented="date"] [data-segment="30d"]');
    expect(listed(sent).at(-1)).toBe(
      `${CONVERSATION_IMPORT_PATH}?harness=codex&q=shop+tests&since=2026-09-13T08%3A00%3A00.000Z&limit=50`,
    );
  });

  it('says it is searching, and when nothing matches', async () => {
    let answer: (value: unknown) => void = () => undefined;
    await open({ list: () => new Promise(resolve => (answer = resolve)) });
    expect(text('[data-continue-reading]')).toBe('Searching…');
    await interact(() => answer(listing([])));
    await settle();
    expect(text('[data-continue-empty]')).toBe('No conversation matches.');
  });

  it('says how many matched when the limit cut the list, and one match in the singular', async () => {
    await open({ list: () => listing([ROWS[0] as ImportableConversation], 120) });
    expect(text('[data-continue-count]')).toBe('1 most recent of 120 matches');
    await view?.unmount();
    await open({ list: () => listing([ROWS[0] as ImportableConversation]) });
    expect(text('[data-continue-count]')).toBe('1 match');
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
    expect(text('[data-continue-count]')).toBe('3 matches');
  });
});

describe('ContinueConversation picking', () => {
  it('opens the ferret that already keeps a conversation instead of making another', async () => {
    const navigated: string[] = [];
    const sent: Sent[] = [];
    await open({ navigated, sent });
    await click('[data-continue-row="notes-kept"]');
    expect(navigated).toEqual(['/d/studio/session/notes-ferret']);
    expect(sent.some(call => call.path === CONVERSATION_ADOPT_PATH)).toBe(false);
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
    expect(text('[data-continue-row="shop-cart"]')).toContain('Starting…');
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
    expect(text('[data-continue-runtimes="shop-cart"]')).toContain('Continue on which runtime?');
    await click('[data-continue-runtime="claude-work"]');
    expect(sent.find(call => call.path === CONVERSATION_ADOPT_PATH)?.body).toMatchObject({ runtime: 'claude-work' });
    expect(navigated).toEqual(['/d/studio/session/s-2']);
  });

  it('says when no runtime drives the conversation’s CLI', async () => {
    await open({ runtimes: () => catalog([CLAUDE]) });
    await click('[data-continue-row="api-codex"]');
    expect(text('[data-continue-issue="api-codex"]')).toBe(
      'No Codex runtime on this machine yet. Add one in Settings › Runtimes, then try again.',
    );
  });

  it('reads no runtimes as none when the runtimes read is refused', async () => {
    await open({ runtimes: () => new FyHttpError('no', 403, 'forbidden') });
    await click('[data-continue-row="shop-cart"]');
    expect(text('[data-continue-issue="shop-cart"]')).toContain('No Claude Code runtime');
  });

  it('shows a refused adoption’s sentence, the daemon’s reason, or a plain fallback', async () => {
    await open({ adopt: () => new FyHttpError('Only the owner may continue conversations.', 403, 'forbidden') });
    await click('[data-continue-row="shop-cart"]');
    expect(text('[data-continue-issue="shop-cart"]')).toBe('Only the owner may continue conversations.');
    await view?.unmount();

    await open({
      adopt: () => ({
        adopted: [],
        refused: [{ id: 'shop-cart', code: 'unavailable', reason: 'Its file is on another disk.' }],
      }),
    });
    await click('[data-continue-row="shop-cart"]');
    expect(text('[data-continue-issue="shop-cart"]')).toBe('Its file is on another disk.');
    await view?.unmount();

    await open({ adopt: () => ({ adopted: [], refused: [] }) });
    await click('[data-continue-row="shop-cart"]');
    expect(text('[data-continue-issue="shop-cart"]')).toBe('This machine didn’t keep it.');
  });
});
