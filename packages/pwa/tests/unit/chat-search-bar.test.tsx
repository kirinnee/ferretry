import { afterEach, describe, expect, test } from 'bun:test';
import type { SessionLogSearch } from '@ferretry/protocol';
import { useRef } from 'react';
import { ChatSearch, type ChatSearchPort } from '../../src/components/chat-search.tsx';
import { CHAT_SEARCH_SETTLE_MS } from '../../src/lib/chat-search.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

/**
 * The chat's search bar over a stand-in transcript: it asks once typing settles, starts at the newest
 * match, loads the history back to it, marks its row, paints every occurrence, and steps with ↑ ↓,
 * Enter and Shift+Enter.
 */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const settle = async (ms = CHAT_SEARCH_SETTLE_MS + 60): Promise<void> =>
  await interact(async () => await new Promise(resolve => setTimeout(resolve, ms)));

interface Asked {
  readonly query: string;
  readonly who: string;
  readonly tools: boolean;
}

const port = (
  answer: (query: string) => SessionLogSearch | Error,
  asked: Asked[] = [],
  reached: [number, string][] = [],
  reach = true,
): ChatSearchPort => ({
  search: async (query, options) => {
    asked.push({ query, who: options.who, tools: options.tools });
    const result = answer(query);
    if (result instanceof Error) throw result;
    return result;
  },
  reach: async (offset, file) => {
    reached.push([offset, file]);
    return reach;
  },
});

const found = (offsets: readonly number[]): SessionLogSearch => ({
  v: 1,
  sessionId: 's',
  query: 'parser',
  file: 'f1',
  matches: offsets.map(offset => ({ offset, role: 'user', kind: 'message', snippet: `parser at ${String(offset)}` })),
  truncated: false,
});

function Scene({
  search,
  onClose = () => undefined,
}: {
  readonly search: ChatSearchPort;
  readonly onClose?: () => void;
}) {
  const transcript = useRef<HTMLDivElement | null>(null);
  return (
    <>
      <ChatSearch agentName="Lizzette" focusSignal={1} onClose={onClose} port={search} transcript={transcript} />
      <div ref={transcript}>
        <div className="fy-transcript">
          <div className="fy-transcript-content">
            <p data-transcript-offset="100">The parser at 100</p>
            <p data-transcript-offset="200">nothing here</p>
            <p data-transcript-offset="300">a PARSER at 300</p>
          </div>
        </div>
      </div>
    </>
  );
}

const box = (view: Mounted): HTMLInputElement => must(view.container.querySelector('input[type="search"]'), 'the box');
const count = (view: Mounted): string => view.container.querySelector('.fy-chat-search__count')?.textContent ?? '';
const currentRow = (view: Mounted): string | null =>
  view.container.querySelector('[data-search-current]')?.getAttribute('data-transcript-offset') ?? null;

const type = async (input: HTMLInputElement, value: string): Promise<void> =>
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

const press = async (target: HTMLElement, key: string, shiftKey = false): Promise<void> =>
  await interact(() => target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true })));

describe('the chat search bar', () => {
  test('asks once typing settles, starts at the newest match, reaches it and marks its row', async () => {
    const asked: Asked[] = [];
    const reached: [number, string][] = [];
    mounted = await mount(<Scene search={port(() => found([100, 300]), asked, reached)} />);
    expect(document.activeElement).toBe(box(mounted));

    await type(box(mounted), 'par');
    await type(box(mounted), 'parser');
    expect(count(mounted)).toBe('Searching…');
    await settle();
    await settle(40);

    expect(asked).toEqual([{ query: 'parser', who: 'all', tools: false }]);
    expect(count(mounted)).toBe('2 of 2');
    expect(reached).toEqual([[300, 'f1']]);
    expect(currentRow(mounted)).toBe('300');
  });

  test('steps back with ↑ and Enter, forward with ↓ and Shift+Enter, wrapping', async () => {
    mounted = await mount(<Scene search={port(() => found([100, 300]))} />);
    await type(box(mounted), 'parser');
    await settle();

    await interact(() =>
      must(mounted?.container.querySelector<HTMLButtonElement>('[aria-label^="Previous"]'), 'up').click(),
    );
    expect(count(mounted)).toBe('1 of 2');
    await settle(40);
    expect(currentRow(mounted)).toBe('100');
    await press(box(mounted), 'Enter');
    expect(count(mounted)).toBe('2 of 2');
    await press(box(mounted), 'Enter', true);
    expect(count(mounted)).toBe('1 of 2');
    await interact(() =>
      must(mounted?.container.querySelector<HTMLButtonElement>('[aria-label^="Next"]'), 'down').click(),
    );
    expect(count(mounted)).toBe('2 of 2');
  });

  test('searches again for whose words and for tools', async () => {
    const asked: Asked[] = [];
    mounted = await mount(<Scene search={port(() => found([100]), asked)} />);
    await type(box(mounted), 'parser');
    await settle();

    const chip = (name: string) =>
      must(
        [...(mounted?.container.querySelectorAll<HTMLButtonElement>('.fy-chat-search__chip') ?? [])].find(
          button => button.textContent === name,
        ),
        name,
      );
    await interact(() => chip('Only mine').click());
    await settle();
    await interact(() => chip('Only Lizzette').click());
    await settle();
    await interact(() =>
      must(mounted?.container.querySelector<HTMLButtonElement>('[data-search-tools]'), 'tools').click(),
    );
    await settle();

    expect(asked.map(ask => `${ask.who}/${String(ask.tools)}`)).toEqual([
      'all/false',
      'me/false',
      'agent/false',
      'agent/true',
    ]);
    expect(chip('Only Lizzette').getAttribute('aria-pressed')).toBe('true');
  });

  test('says there is nothing, and clears when the box is emptied', async () => {
    mounted = await mount(<Scene search={port(() => found([]))} />);
    await type(box(mounted), 'quokka');
    await settle();
    expect(count(mounted)).toBe('No matches');
    expect(must(mounted.container.querySelector<HTMLButtonElement>('[aria-label^="Previous"]'), 'up').disabled).toBe(
      true,
    );

    await type(box(mounted), '');
    await settle(20);
    expect(count(mounted)).toBe('');
  });

  test('waits for the rows a jump loaded to be drawn before it looks for the match', async () => {
    mounted = await mount(<Scene search={port(() => found([40]))} />);
    await type(box(mounted), 'parser');
    await settle();
    // The page holding the match is drawn a few frames after the history reached it.
    await settle(50);
    const content = must(mounted.container.querySelector('.fy-transcript-content'), 'content');
    await interact(() => {
      const row = document.createElement('p');
      row.dataset.transcriptOffset = '40';
      row.textContent = 'parser at 40';
      content.prepend(row);
    });
    await settle(120);
    expect(currentRow(mounted)).toBe('40');
  });

  test('takes the mark off the match’s row when the box is emptied', async () => {
    mounted = await mount(<Scene search={port(() => found([300]))} />);
    await type(box(mounted), 'parser');
    await settle();
    await settle(40);
    expect(currentRow(mounted)).toBe('300');

    await type(box(mounted), '');
    await settle(40);
    expect(currentRow(mounted)).toBeNull();
  });

  test('says a failed search in its own words', async () => {
    mounted = await mount(<Scene search={port(() => new Error('the daemon is away'))} />);
    await type(box(mounted), 'parser');
    await settle();
    expect(count(mounted)).toBe('Search failed');
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe('the daemon is away');
  });

  test('says when a match is further back than the chat can load, with its words', async () => {
    mounted = await mount(<Scene search={port(() => found([100]), [], [], false)} />);
    await type(box(mounted), 'parser');
    await settle();
    await settle(40);
    expect(mounted.container.querySelector('.fy-chat-search__note')?.textContent).toContain('parser at 100');
  });

  test('closes on Escape and on its button', async () => {
    const closed: string[] = [];
    mounted = await mount(<Scene onClose={() => closed.push('closed')} search={port(() => found([]))} />);
    await press(box(mounted), 'Escape');
    await interact(() =>
      must(mounted?.container.querySelector<HTMLButtonElement>('[aria-label="Close search"]'), 'x').click(),
    );
    expect(closed).toEqual(['closed', 'closed']);
  });

  test('paints every occurrence as highlights where the browser can, and wipes them when it closes', async () => {
    const painted = new Map<string, number>();
    const deleted: string[] = [];
    // happy-dom has neither, and its `CSS` is read-only: both are defined for this case and put back after.
    const saved = {
      Highlight: Object.getOwnPropertyDescriptor(globalThis, 'Highlight'),
      CSS: Object.getOwnPropertyDescriptor(globalThis, 'CSS'),
    };
    Object.defineProperty(globalThis, 'Highlight', {
      configurable: true,
      writable: true,
      value: class {
        readonly ranges: unknown[];
        constructor(...ranges: unknown[]) {
          this.ranges = ranges;
        }
      },
    });
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      writable: true,
      value: {
        highlights: {
          set: (name: string, value: { ranges: unknown[] }) => painted.set(name, value.ranges.length),
          delete: (name: string) => deleted.push(name),
        },
      },
    });
    try {
      mounted = await mount(<Scene search={port(() => found([100, 300]))} />);
      await type(box(mounted), 'parser');
      await settle();
      await settle(40);
      expect(painted.get('fy-search')).toBe(1);
      expect(painted.get('fy-search-current')).toBe(1);

      // A row arriving is painted too.
      const content = must(mounted.container.querySelector('.fy-transcript-content'), 'content');
      await interact(() => {
        const row = document.createElement('p');
        row.textContent = 'another parser, and a parser';
        content.append(row);
      });
      await settle(40);
      expect(painted.get('fy-search')).toBe(3);

      await mounted.unmount();
      mounted = null;
      expect(deleted).toContain('fy-search');
      expect(deleted).toContain('fy-search-current');
    } finally {
      for (const [name, descriptor] of Object.entries(saved))
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
        else Object.defineProperty(globalThis, name, descriptor);
    }
  });
});
