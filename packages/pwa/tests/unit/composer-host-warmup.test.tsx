/**
 * The warm-up handshake: a family that arrives WITH the host's own commit.
 *
 * `autocompleteReady` exists so the first menu of a session waits for the page's
 * one read instead of inventing an answer. But a host publishes that answer as
 * PROPS, and props are only readable after React commits — while a promise
 * resolves on the microtask queue, which is strictly earlier. A menu that
 * resumes on the promise alone therefore re-reads the host getter one render too
 * soon and publishes a READY result from it: an empty family, or the "not read
 * yet" notice on a catalog that had already arrived.
 *
 * It self-corrects on the next render, so the symptom is a FLASH rather than a
 * durable wrong answer. That is precisely why sampling the settled menu proves
 * nothing here: `act` collapses the intermediate commits, and the frame a reader
 * would actually have seen is gone by the time the test looks. So these tests
 * record every frame through a `<Profiler>` around the composer, which reports
 * each real commit of its subtree, and assert about the first frame that is
 * ready to act on.
 *
 * The host is shaped like the real page: one promise handed down as
 * `autocompleteReady`, and the props it advertises published by a `setState`
 * inside that same promise's continuation, exactly as
 * `useComposerReferenceCatalogs` publishes a family from the read `settled()`
 * reports on.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Profiler, useCallback, useRef, useState } from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Composer } from '../../src/components/composer.tsx';
import type {
  ComposerSkillsCatalog,
  ComposerTaskSummary,
} from '../../src/components/composer-autocomplete-providers.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { render, run, runAsync } from '../support/react.ts';

const renderers: ReactTestRenderer[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  run(() => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
  globalThis.fetch = originalFetch;
});

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.example.test',
  deviceToken: 'token-a',
});
const api = { send: async () => undefined } as never;

const CATALOG: ComposerSkillsCatalog = {
  harness: 'claude',
  skills: [{ name: 'summary', description: 'Give a fast recap' }],
};
const TASKS: readonly ComposerTaskSummary[] = [{ id: 'F12', title: 'Ship autocomplete', status: 'in_progress' }];

const mounted = (element: Parameters<typeof render>[0]): ReactTestRenderer => {
  const renderer = render(element);
  renderers.push(renderer);
  return renderer;
};

const type = (view: ReactTestRenderer, value: string): void => {
  run(() =>
    view.root
      .findByType('textarea')
      .props.onChange({ currentTarget: { value, selectionStart: value.length, selectionEnd: value.length } }),
  );
};

const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : textOf(child))).join(' ');

interface MenuFrame {
  readonly rows: number;
  readonly text: string;
}

/** What a reader would see in THIS committed frame: the popover's own text and
 *  how many rows of the family it is offering. */
const sampleMenu = (view: ReactTestRenderer, family: 'Skills' | 'Tasks'): MenuFrame => {
  const popover = view.root.findAllByProps({ 'data-composer-autocomplete': family })[0];
  return {
    rows: view.root.findAllByProps({ 'data-kind': family === 'Skills' ? 'skill' : 'task' }).length,
    text: popover === undefined ? '' : textOf(popover),
  };
};

/** A frame a reader could act on: the menu is open and no longer loading. */
const isReady = (frame: MenuFrame): boolean => frame.text !== '' && !frame.text.includes('Searching…');

/** Microtask turns only — never a timer, so nothing waits on a wall clock. The
 *  count is a bound rather than a delay: each turn either advances a pending
 *  continuation or does nothing at all. */
const drain = async (): Promise<void> => {
  for (let turn = 0; turn < 24; turn++) await Promise.resolve();
};

/**
 * The production host shape, reduced to the two things that race: ONE readiness
 * promise, and props published by a `setState` in that promise's continuation.
 */
function CatalogHost<Value>({
  read,
  prop,
  onCommit,
}: {
  readonly read: Promise<Value>;
  readonly prop: (value: Value | undefined) => Record<string, unknown>;
  readonly onCommit: () => void;
}) {
  const [value, setValue] = useState<Value | undefined>(undefined);
  const pending = useRef<Promise<void> | null>(null);
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    const owned = read.then(answer => {
      setValue(answer);
    });
    pending.current = owned;
    void owned.finally(() => {
      if (pending.current === owned) pending.current = null;
    });
  }
  // Stable, and honest about being finished: once the read settles it reports
  // nothing to wait for, which is what the real hook's `settled()` does.
  const ready = useCallback((): Promise<void> | undefined => pending.current ?? undefined, []);
  // The Profiler wraps the COMPOSER, so a commit driven by the composer's own
  // state — which is exactly what the handshake schedules — is reported here
  // too, not only a commit the host itself caused.
  return (
    <Profiler id="composer" onRender={onCommit}>
      <Composer api={api} autocompleteReady={ready} daemon={daemon} sessionId="session-a" {...prop(value)} />
    </Profiler>
  );
}

describe('composer host warm-up handshake', () => {
  test('never publishes a ready skills menu about a catalog the host has already answered with', async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response('{}', { status: 500 });
    }) as typeof fetch;

    let deliver: (catalog: ComposerSkillsCatalog) => void = () => undefined;
    const read = new Promise<ComposerSkillsCatalog>(resolve => {
      deliver = resolve;
    });
    const frames: MenuFrame[] = [];
    const holder: { view?: ReactTestRenderer } = {};
    holder.view = mounted(
      <CatalogHost
        onCommit={() => {
          if (holder.view !== undefined) frames.push(sampleMenu(holder.view, 'Skills'));
        }}
        prop={value => (value === undefined ? {} : { autocompleteSkills: value })}
        read={read}
      />,
    );
    const view = holder.view;

    // The window a reader actually meets: the page's one read is still in
    // flight and the menu opens inside it.
    type(view, '$sum');
    expect(isReady(sampleMenu(view, 'Skills'))).toBe(false);
    frames.length = 0;

    // Deliver in the resolve-before-commit boundary. Every commit from here is
    // a frame a reader could have seen, and the Profiler has all of them.
    await runAsync(async () => {
      deliver(CATALOG);
      await drain();
    });

    const firstReady = frames.find(isReady);
    if (firstReady === undefined) throw new Error('the menu never settled');
    // THE CLAIM. The first answer the reader is given is the catalog that
    // arrived — never an "unread" notice about one the host is already holding.
    expect(firstReady.text).not.toContain('have not been read for this session yet');
    expect(firstReady.rows).toBeGreaterThan(0);
    // And the host's answer stayed the only answer: no second request for a
    // fact that was already being fetched.
    expect(requests.filter(url => url.includes('/skills'))).toEqual([]);
  });

  test('never publishes a ready tasks menu that invents an empty family', async () => {
    let deliver: (tasks: readonly ComposerTaskSummary[]) => void = () => undefined;
    const read = new Promise<readonly ComposerTaskSummary[]>(resolve => {
      deliver = resolve;
    });
    const frames: MenuFrame[] = [];
    const holder: { view?: ReactTestRenderer } = {};
    holder.view = mounted(
      <CatalogHost
        onCommit={() => {
          if (holder.view !== undefined) frames.push(sampleMenu(holder.view, 'Tasks'));
        }}
        prop={value => (value === undefined ? {} : { autocompleteTasks: value })}
        read={read}
      />,
    );
    const view = holder.view;

    type(view, '&F12');
    frames.length = 0;
    await runAsync(async () => {
      deliver(TASKS);
      await drain();
    });

    // THE CLAIM, in the same shape as the skills proof above. The pre-delivery
    // frames were cleared, so the first READY frame here is the first answer
    // the reader is given once the family exists — and it must already carry
    // it. A ready-empty frame followed by a correct one IS the flash under
    // test, so accepting one would accept the defect.
    const firstReady = frames.find(isReady);
    if (firstReady === undefined) throw new Error('the menu never settled');
    expect(firstReady.rows).toBeGreaterThan(0);
    expect(frames.filter(isReady).every(frame => frame.rows > 0)).toBe(true);
  });

  test('still answers when the host has nothing in flight to wait for', async () => {
    const settled = mounted(<Composer api={api} autocompleteSkills={CATALOG} daemon={daemon} sessionId="session-a" />);

    type(settled, '$sum');
    await runAsync(drain);

    // No readiness promise at all. The handshake must not invent a wait, or a
    // host that finished before the menu opened would never get an answer.
    expect(sampleMenu(settled, 'Skills').rows).toBeGreaterThan(0);
  });
});
