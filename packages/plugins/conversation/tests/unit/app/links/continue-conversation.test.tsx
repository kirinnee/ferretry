import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import type { LinkableConversation, LinkPreview } from '../../../../contract/index.ts';
import { ContinueConversation } from '../../../../app/links/continue-conversation.tsx';
import type { RuntimeField } from '../../../../app/links/conversation-picker.tsx';
import { type CallHandler, type FakeClient, fakeClient, refusal } from '../../../support/app/client.tsx';
import {
  conversation,
  ferret,
  hoursAgo as at,
  listing,
  NOW,
  runtimeField,
  settle,
  type,
} from '../../../support/app/links.ts';

const LIST = 'GET /v1/links/conversations';
const PREVIEW_ROUTE = 'GET /v1/links/conversations/:harness/:conversationId/preview';
const KEEP = 'POST /v1/links/conversations/keep';
const ALL = { source: 'synced', limit: '50' };
const KEPT = { source: 'ferretry', limit: '1000' };
const DAEMON = 'studio';

type Handler = CallHandler;

/** The daemon refusing, as the shell’s client throws it. */
const refuse =
  (message: string, status: number, code: string): Handler =>
  () => {
    throw refusal(status, code, message);
  };

/** The listing route answers every search; the preview and keep routes answer as given. */
const machine = (routes: { list?: Handler; preview?: Handler; keep?: Handler }): FakeClient =>
  fakeClient(
    {
      ...(routes.list === undefined ? {} : { [LIST]: routes.list }),
      ...(routes.preview === undefined ? {} : { [PREVIEW_ROUTE]: routes.preview }),
      ...(routes.keep === undefined ? {} : { [KEEP]: routes.keep }),
    },
    DAEMON,
  );

/** The runtime slot as Runtimes fills it here: one runtime per CLI. */
const RUNTIMES = runtimeField({ 'claude-code': ['claude-default-w'], codex: ['codex-default'] });

const ROWS: readonly LinkableConversation[] = [
  conversation('shop-cart', { latest: 'and now the tests' }),
  conversation('api-codex', { harness: 'codex', project: '/work/api', model: undefined }),
  conversation('notes-kept', { project: '/work/notes', keptBy: 'notes-ferret' }),
];

const PREVIEW: LinkPreview = {
  id: 'shop-cart',
  harness: 'claude-code',
  messages: [
    { role: 'user', text: 'Fix the cart total' },
    { role: 'assistant', text: 'Fixed the rounding.' },
  ],
};

// Ferrets’ summary says a failed ferret as `stopped`; a ferret’s mark is its label, else its name.
const FERRETS: readonly FerretSummary[] = [
  ferret('notes-ferret', { name: 'notes', label: 'Mika', folder: '/work/notes', state: 'stopped', stateAt: at(2) }),
  ferret('api-ferret', { name: 'api', harness: 'codex', folder: '/work/api', state: 'stopped', stateAt: at(30) }),
  ferret('live-ferret', { state: 'working', stateAt: at(1) }),
];

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

interface OpenOptions {
  readonly list?: Handler;
  readonly preview?: Handler;
  readonly runtimeField?: RuntimeField;
  readonly keep?: Handler;
  /** A client to reuse, so its calls are counted across mounts. */
  readonly client?: FakeClient;
  readonly navigated?: string[];
  readonly now?: boolean;
  /** Present hands the ferrets (and a resume) in. */
  readonly ferrets?: readonly FerretSummary[] | null;
  readonly resumed?: string[];
  readonly resume?: (id: string) => Promise<void>;
}

let client: FakeClient = machine({});

const open = async (options: OpenOptions = {}): Promise<Mounted> => {
  client =
    options.client ??
    machine({
      list: options.list ?? (() => listing(ROWS)),
      preview: options.preview ?? (() => PREVIEW),
      ...(options.keep === undefined ? {} : { keep: options.keep }),
    });
  const resume =
    options.resume ??
    (async (id: string) => {
      options.resumed?.push(id);
    });
  view = await mount(
    <ContinueConversation
      client={client}
      daemon={DAEMON}
      onOpenFerret={id => options.navigated?.push(id)}
      runtimeField={options.runtimeField ?? RUNTIMES}
      {...(options.now === false ? {} : { now: () => NOW })}
      {...(options.ferrets === undefined ? {} : { ferrets: options.ferrets, resume })}
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
const listed = (from: FakeClient = client): readonly Readonly<Record<string, string>>[] =>
  from.callsTo(LIST).map(call => call.query);
const sentKeep = (): unknown => client.callsTo(KEEP)[0]?.body;
const action = (key: string): string => `[data-continue-action="${key}"]`;
/** Picks a runtime in the slot’s stand-in, then continues on it. */
const continueOn = async (wrapper: string): Promise<void> => {
  await click(`[data-test-runtime="${wrapper}"]`);
  await click(`[data-continue-on-runtime="${wrapper}"]`);
};
const SHOP = 'conversation:claude-code:shop-cart';

describe('ContinueConversation over all conversations', () => {
  it('heads a named conversation by its name and finds it by that name', async () => {
    await open({ list: () => listing([conversation('shop-cart', { name: 'Cart total bugfix', latest: 'ship it' })]) });
    const row = '[data-continue-row="shop-cart"]';
    expect(text(`${row} [data-conversation-name]`)).toBe('Cart total bugfix');
    expect(text(`${row} [data-conversation-first]`)).toBe('Fix the shop-cart page');
  });

  it('lists Ferretry’s own conversations: first message and age, the latest message, then its marks', async () => {
    await open();
    expect(listed()).toEqual([ALL, KEPT]);
    expect(find('[data-segmented="source"] [data-segment="all"]').getAttribute('aria-pressed')).toBe('true');
    expect(text('[data-continue-count]')).toBe('3 conversations');
    const row = '[data-continue-row="shop-cart"]';
    expect(text(`${row} [data-conversation-age]`)).toBe('1d ago');
    expect(text(`${row} .fy-convo-title`)).toBe('Fix the shop-cart page');
    expect(text(`${row} [data-conversation-latest]`)).toBe('Latest: and now the tests');
    expect(text(`${row} [data-conversation-harness="claude-code"]`)).toBe('Claude');
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
    await open();
    await type(find<HTMLInputElement>('[data-continue-search]'), ' shop tests ');
    await settle();
    await click('[data-segmented="source"] [data-segment="codex"]');
    await click('[data-segmented="date"] [data-segment="30d"]');
    expect(listed().at(-1)).toEqual({
      source: 'synced',
      harness: 'codex',
      q: 'shop tests',
      since: '2026-09-13T08:00:00.000Z',
      limit: '50',
    });
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
    await open({ list: () => listing([ROWS[0] as LinkableConversation], 120) });
    expect(text('[data-continue-count]')).toBe('1 conversation · newest 1 of 120');
    await view?.unmount();
    await open({ list: () => listing([ROWS[0] as LinkableConversation]) });
    expect(text('[data-continue-count]')).toBe('1 conversation');
  });

  it('shows a refused search’s sentence', async () => {
    await open({ list: refuse('Enter your passkey to search conversations.', 403, 'step_up') });
    expect(text('[data-continue-refused]')).toBe('Enter your passkey to search conversations.');
  });

  it('drops a search answer that lands after it left', async () => {
    let answer: (value: unknown) => void = () => undefined;
    await open({ list: () => new Promise(resolve => (answer = resolve)) });
    await view?.unmount();
    view = null;
    await interact(() => {
      answer(listing(ROWS));
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
    let answer: (value: unknown) => void = () => undefined;
    await open({ preview: () => new Promise(resolve => (answer = resolve)) });
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
    expect(client.callsTo(PREVIEW_ROUTE).map(call => call.params)).toEqual([
      { harness: 'claude-code', conversationId: 'shop-cart' },
    ]);

    await click('[data-continue-row="shop-cart"]');
    expect(view?.container.querySelector(`[data-continue-preview="${SHOP}"]`)).toBeNull();
    await click('[data-continue-row="shop-cart"]');
    expect(client.callsTo(PREVIEW_ROUTE)).toHaveLength(1);
  });

  it('opens one row at a time, and says when a preview is refused or empty', async () => {
    await open({
      preview: call =>
        call.params.conversationId === 'api-codex'
          ? { id: 'api-codex', harness: 'codex', messages: [] }
          : refuse('Enter your passkey to read it.', 403, 'step_up')(call),
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
    await open({ navigated });
    await click('[data-continue-row="notes-kept"]');
    expect(text(action('conversation:claude-code:notes-kept'))).toBe('Open ferret');
    await click(action('conversation:claude-code:notes-kept'));
    expect(navigated).toEqual(['notes-ferret']);
    expect(client.callsTo(KEEP)).toHaveLength(0);
  });

  it('resumes a stopped ferret that keeps a conversation, in place', async () => {
    const navigated: string[] = [];
    const resumed: string[] = [];
    await open({ navigated, resumed, ferrets: FERRETS });
    await click('[data-continue-row="notes-kept"]');
    expect(text(action('conversation:claude-code:notes-kept'))).toBe('Resume ferret');
    await click(action('conversation:claude-code:notes-kept'));
    expect(resumed).toEqual(['notes-ferret']);
    expect(navigated).toEqual(['notes-ferret']);
  });

  it('keeps on the runtime picked with start on, then opens the new ferret', async () => {
    const navigated: string[] = [];
    let release: (value: unknown) => void = () => undefined;
    const gate = new Promise(resolve => (release = resolve));
    await open({
      navigated,
      keep: () =>
        gate.then(() => ({
          kept: [{ id: 'shop-cart', ferret: 's-9', name: 'shop', state: 'working' }],
          refused: [],
        })),
    });
    await click('[data-continue-row="shop-cart"]');
    await click(action(SHOP));
    expect(text('[data-continue-runtimes="shop-cart"]')).toContain('Continue on which runtime?');
    expect(client.callsTo(KEEP)).toHaveLength(0);
    await continueOn('claude-default-w');
    expect(text(action(SHOP))).toBe('Starting…');
    expect(find<HTMLButtonElement>('[data-continue-row="api-codex"]').disabled).toBe(true);
    await interact(() => release(undefined));
    await settle();
    expect(sentKeep()).toEqual({
      harness: 'claude-code',
      runtime: 'claude-default-w',
      conversations: [{ id: 'shop-cart', start: true }],
    });
    expect(navigated).toEqual(['s-9']);
  });

  it('asks which runtime of the conversation’s CLI, and continues only once one is picked', async () => {
    const navigated: string[] = [];
    await open({
      navigated,
      runtimeField: runtimeField({ 'claude-code': ['claude-default-w', 'claude-work'], codex: ['codex-default'] }),
      keep: () => ({ kept: [{ id: 'shop-cart', ferret: 's-2', name: 'shop', state: 'working' }], refused: [] }),
    });
    await click('[data-continue-row="shop-cart"]');
    await click(action(SHOP));
    expect(text('[data-continue-runtimes="shop-cart"]')).toContain('Continue on which runtime?');
    expect(
      [...(view?.container.querySelectorAll('[data-test-runtimes="claude-code"] [data-test-runtime]') ?? [])].map(
        item => item.textContent,
      ),
    ).toEqual(['claude-default-w', 'claude-work']);
    expect(find<HTMLButtonElement>('[data-continue-on-runtime=""]').disabled).toBe(true);
    await continueOn('claude-work');
    expect(sentKeep()).toMatchObject({ runtime: 'claude-work' });
    expect(navigated).toEqual(['s-2']);
  });

  it('says when no runtime drives the conversation’s CLI', async () => {
    await open({ runtimeField: runtimeField({ 'claude-code': ['claude-default-w'] }) });
    await click('[data-continue-row="api-codex"]');
    await click(action('conversation:codex:api-codex'));
    expect(text('[data-continue-runtimes="api-codex"] [data-continue-no-runtime]')).toBe(
      'No Codex runtime on this machine yet. Add one in Settings › Runtimes, then try again.',
    );
  });

  it('says it cannot continue a conversation of a CLI this app has no words for', async () => {
    await open({ list: () => listing([conversation('gem-one', { harness: 'gemini' })]) });
    await click('[data-continue-row="gem-one"]');
    await click(action('conversation:gemini:gem-one'));
    expect(text('[data-continue-issue="conversation:gemini:gem-one"]')).toBe(
      'This app can’t continue a gemini conversation.',
    );
    expect(view?.container.querySelector('[data-continue-runtimes]')).toBeNull();
  });

  it('shows a refused keep’s sentence, the daemon’s reason, or a plain fallback', async () => {
    const keepThen = async (keep: Handler): Promise<string> => {
      await view?.unmount();
      await open({ keep });
      await click('[data-continue-row="shop-cart"]');
      await click(action(SHOP));
      await continueOn('claude-default-w');
      return text(`[data-continue-issue="${SHOP}"]`);
    };
    expect(await keepThen(refuse('Only the owner may continue conversations.', 403, 'forbidden'))).toBe(
      'Only the owner may continue conversations.',
    );
    expect(
      await keepThen(() => ({
        kept: [],
        refused: [{ id: 'shop-cart', code: 'unavailable', reason: 'Its file is on another disk.' }],
      })),
    ).toBe('Its file is on another disk.');
    expect(await keepThen(() => ({ kept: [], refused: [] }))).toBe('This machine didn’t keep it.');
  });
});

describe('ContinueConversation marks and the Ferretry filter', () => {
  it('marks a conversation a ferret keeps with the ferret, its state and its CLI, under the conversation’s name', async () => {
    await open({
      ferrets: FERRETS,
      list: () =>
        listing([
          conversation('notes-kept', { project: '/work/notes', keptBy: 'notes-ferret', name: 'Notes cleanup' }),
        ]),
    });
    const row = '[data-continue-row="notes-kept"]';
    expect(text(`${row} [data-conversation-name]`)).toBe('Notes cleanup');
    expect(text(`${row} [data-conversation-first]`)).toBe('Fix the notes-kept page');
    expect(text(`${row} [data-conversation-ferret="notes-ferret"]`)).toBe('Ferret Mika · stopped');
    expect(text(`${row} [data-conversation-harness="claude-code"]`)).toBe('Claude');
    expect(find(`${row} .fy-convo-avatar__dot`).getAttribute('data-state')).toBe('stopped');
    expect(text(`${row} .fy-convo-avatar__initial`)).toBe('M');
  });

  it('lists the stopped ferrets the listing does not describe in every source that fits', async () => {
    await open({ ferrets: FERRETS });
    expect(text('[data-continue-count]')).toBe('4 conversations');
    const bare = '[data-continue-ferret="api-ferret"]';
    expect(text(`${bare} .fy-convo-title`)).toBe('api');
    expect(text(`${bare} [data-conversation-age]`)).toBe('1d ago');
    expect(text(`${bare} [data-conversation-ferret="api-ferret"]`)).toBe('Ferret api · stopped');
    expect(text(`${bare} [data-conversation-harness="codex"]`)).toBe('Codex');
    expect(find(`${bare} .fy-convo-avatar__dot`).getAttribute('data-state')).toBe('stopped');
    await click('[data-segmented="source"] [data-segment="claude-code"]');
    expect(view?.container.querySelector(bare)).toBeNull();
  });

  it('narrows Ferretry to what ferrets keep and the stopped ferrets, searching the ferret’s name too', async () => {
    await open({ ferrets: FERRETS });
    await click('[data-segmented="source"] [data-segment="ferretry"]');
    expect(listed()).toEqual([ALL, KEPT]);
    expect(text('[data-continue-count]')).toBe('2 conversations');
    const rows = [...(view?.container.querySelectorAll('[data-continue-row], [data-continue-ferret]') ?? [])];
    expect(rows.map(row => row.getAttribute('data-continue-row') ?? row.getAttribute('data-continue-ferret'))).toEqual([
      'notes-kept',
      'api-ferret',
    ]);
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
      ferrets: FERRETS,
      resume: async id => {
        const failure = failures.shift();
        if (failure !== undefined) throw failure;
        await gate;
        resumed.push(id);
      },
    });
    await click('[data-continue-ferret="api-ferret"]');
    expect(find('[data-continue-ferret="api-ferret"]').closest('li')?.hasAttribute('data-open')).toBe(true);
    expect(text('[data-continue-preview="ferret:api-ferret"]')).toContain(
      'No preview of this ferret’s conversation is available.',
    );
    await click(action('ferret:api-ferret'));
    expect(text('[data-continue-issue="ferret:api-ferret"]')).toBe('The pane would not open.');
    await click(action('ferret:api-ferret'));
    expect(text('[data-continue-issue="ferret:api-ferret"]')).toBe('The ferret could not resume.');
    await click(action('ferret:api-ferret'));
    expect(text(action('ferret:api-ferret'))).toBe('Resuming…');
    await interact(() => release());
    await settle();
    expect(resumed).toEqual(['api-ferret']);
    expect(navigated).toEqual(['api-ferret']);
  });

  it('waits for the ferrets, lists them bare when the kept listing is refused, and says when Ferretry has none', async () => {
    await open({ ferrets: null });
    expect(text('[data-continue-reading]')).toBe('Searching…');
    await view?.unmount();
    await open({ ferrets: FERRETS, list: refuse('no', 403, 'forbidden') });
    await click('[data-segmented="source"] [data-segment="ferretry"]');
    expect(text('[data-continue-ferret="notes-ferret"]')).toContain('Mika');
    await view?.unmount();
    await open({ ferrets: [FERRETS[2] as FerretSummary], list: () => listing([]) });
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
    await open({ ferrets: FERRETS });
    await click('[data-continue-row="shop-cart"]');
    expect(view?.container.querySelector('[data-continue-preview]')).not.toBeNull();
    await click('[data-segmented="source"] [data-segment="claude-code"]');
    expect(view?.container.querySelector('[data-continue-preview]')).toBeNull();
  });
});

describe('ContinueConversation over this computer', () => {
  const COMPUTER_ROWS = [
    conversation('mac-new', { keptIn: 'computer', daysAgo: 0.4, name: 'Release notes' }),
    conversation('mac-codex', { keptIn: 'computer', harness: 'codex', daysAgo: 3, turnsAtLeast: true, turns: 2000 }),
    conversation('mac-kept', { keptIn: 'computer', keptBy: 'notes-ferret', daysAgo: 1 }),
    conversation('mine', { keptIn: 'ferretry', daysAgo: 2 }),
  ];
  const computer = '[data-segmented="source"] [data-segment="computer"]';

  it('marks the rows that are on this computer, and only those', async () => {
    // Arrange
    await open({ list: () => listing(COMPUTER_ROWS) });

    // Act
    const badges = [...(view?.container.querySelectorAll('[data-conversation-computer]') ?? [])];
    const actual = badges.map(badge => badge.closest('[data-continue-row]')?.getAttribute('data-continue-row'));

    // Assert
    expect(actual).toEqual(['mac-new', 'mac-kept', 'mac-codex']);
    expect(text('[data-continue-row="mac-new"] [data-conversation-computer]')).toBe('On this computer');
    expect(find('[data-continue-row="mac-new"] [data-conversation-computer]').getAttribute('data-source')).toBe(
      'computer',
    );
  });

  it('narrows to the rows only on this computer, asking for more of the answer', async () => {
    // Arrange
    await open({ list: () => listing(COMPUTER_ROWS) });

    // Act
    await click(computer);

    // Assert
    const rows = [...(view?.container.querySelectorAll('[data-continue-row]') ?? [])];
    expect(rows.map(row => row.getAttribute('data-continue-row'))).toEqual(['mac-new', 'mac-codex']);
    expect(listed().at(-1)).toEqual({ source: 'synced', limit: '200' });
  });

  it('keeps a computer row like any other: start on, then opens the new ferret', async () => {
    // Arrange
    const navigated: string[] = [];
    await open({
      navigated,
      list: () => listing(COMPUTER_ROWS),
      keep: () => ({ kept: [{ id: 'mac-new', ferret: 's-3', name: 'mac', state: 'working' }], refused: [] }),
    });
    await click(computer);

    // Act
    await click('[data-continue-row="mac-new"]');
    await click(action('conversation:claude-code:mac-new'));
    await continueOn('claude-default-w');

    // Assert
    expect(sentKeep()).toEqual({
      harness: 'claude-code',
      runtime: 'claude-default-w',
      conversations: [{ id: 'mac-new', start: true }],
    });
    expect(navigated).toEqual(['s-3']);
  });

  it('says why nothing is here when Keep in sync is off, and where to turn it on', async () => {
    // Arrange
    await open({ list: () => listing([conversation('mine', { keptIn: 'ferretry' })], 1, false) });

    // Act
    await click(computer);

    // Assert
    expect(text('[data-continue-computer-hidden]')).toBe(
      'Conversations on this computer are hidden. Turn on Keep in sync in Settings › Machine › Conversations.',
    );
    expect(text('[data-continue-empty]')).toBe('Nothing to show: Keep in sync is off.');
  });

  it('keeps the hint away from the Ferretry chip and from a listing that includes the computer', async () => {
    // Arrange
    await open({ list: () => listing([conversation('mine', { keptIn: 'ferretry' })], 1, false) });

    // Act
    await click('[data-segmented="source"] [data-segment="ferretry"]');
    const onFerretry = view?.container.querySelector('[data-continue-computer-hidden]');
    await view?.unmount();
    await open({ list: () => listing(COMPUTER_ROWS) });
    const onSynced = view?.container.querySelector('[data-continue-computer-hidden]');

    // Assert
    expect([onFerretry, onSynced]).toEqual([null, null]);
  });

  it('reads the list again each time it opens, with no timer between', async () => {
    // Arrange
    await open();
    const reused = client;
    const first = listed(reused).length;

    // Act
    await view?.unmount();
    await open({ client: reused });
    await settle();

    // Assert
    expect([first, listed(reused).length]).toEqual([2, 4]);
  });

  it('starts over when the machine changes: its rows, its chip, its open row', async () => {
    // Arrange
    await open({ list: () => listing(COMPUTER_ROWS) });
    await click(computer);
    await click('[data-continue-row="mac-new"]');
    const other = fakeClient({ [LIST]: () => listing([conversation('laptop-row')]) }, 'laptop');

    // Act
    await view?.render(
      <ContinueConversation
        client={other}
        daemon="laptop"
        onOpenFerret={() => undefined}
        runtimeField={RUNTIMES}
        now={() => NOW}
        debounceMs={0}
      />,
    );
    await settle();

    // Assert
    const rows = [...(view?.container.querySelectorAll('[data-continue-row]') ?? [])];
    expect(rows.map(row => row.getAttribute('data-continue-row'))).toEqual(['laptop-row']);
    expect(find('[data-segmented="source"] [data-segment="all"]').getAttribute('aria-pressed')).toBe('true');
    expect(view?.container.querySelector('[data-continue-preview]')).toBeNull();
    expect(listed(other).length).toBeGreaterThan(0);
  });
});
