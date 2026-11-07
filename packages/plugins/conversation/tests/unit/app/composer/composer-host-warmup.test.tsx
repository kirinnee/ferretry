/**
 * The warm-up handshake: a family that arrives WITH the host's own commit.
 *
 * `referenceCatalogs.settled` exists so the first menu of a ferret waits for the page's
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
 * `referenceCatalogs.settled`, and the catalogs it advertises published by a `setState`
 * inside that same promise's continuation, exactly as
 * `useComposerReferenceCatalogs` publishes a family from the read `settled()`
 * reports on.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Profiler, useCallback, useRef, useState } from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Composer } from '../../../../app/composer/composer.tsx';
import { composerSuggestionSwitches } from '../../../../app/composer/composer-autocomplete.ts';
import { daemonConnection } from '../../../../app/composer/seam.ts';
import { ensureDom, render, run, runAsync } from '@ferretry/app/testing';
import type { ReferenceCatalogEntry, ReferenceCatalogPrefix } from '../../../../contract/index.ts';
import { fakeClient, withClient } from '../../../support/app/composer-host.tsx';
import { writeMdComposePref } from '@ferretry/app';

ensureDom();

// The general composer behaviour is one key arbitration for every editor style; these suites drive it
// through the Plain textarea. The live editor (Markdown and Rich text) has its own suites.
beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

const renderers: ReactTestRenderer[] = [];

afterEach(() => {
  run(() => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
});

const daemon = daemonConnection('daemon-a');
const api = { send: async () => undefined } as never;

const CATALOG: readonly ReferenceCatalogEntry[] = [{ token: 'summary', label: '', detail: 'Give a fast recap' }];
const AGENDA: readonly ReferenceCatalogEntry[] = [{ token: 'A3', label: 'Pick a window', detail: 'question' }];
const TASKS: readonly ReferenceCatalogEntry[] = [{ token: 'F12', label: 'Ship the picker', detail: 'In progress' }];

/** Every read a family makes of its own is recorded and refused: the host is the only source here. */
const reads: { readonly prefix: string | undefined }[] = [];
const CLIENT = fakeClient(async (_route, init) => {
  reads.push({ prefix: init?.query?.prefix });
  throw new Error('not in this suite');
});
beforeEach(() => {
  reads.length = 0;
});

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
const sampleMenu = (view: ReactTestRenderer, family: 'Skills' | 'References' | 'Tasks', kind?: string): MenuFrame => {
  const popover = view.root.findAllByProps({ 'data-composer-autocomplete': family })[0];
  return {
    rows: view.root.findAllByProps({ 'data-kind': kind ?? (family === 'Skills' ? 'skill' : 'attention') }).length,
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
function CatalogHost({
  read,
  prefix,
  extra = {},
  onCommit,
}: {
  readonly read: Promise<readonly ReferenceCatalogEntry[]>;
  readonly prefix: ReferenceCatalogPrefix;
  readonly extra?: Record<string, unknown>;
  readonly onCommit: () => void;
}) {
  const [value, setValue] = useState<readonly ReferenceCatalogEntry[] | undefined>(undefined);
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
      <Composer
        api={api}
        referenceCatalogs={{
          entries: value === undefined ? {} : { [prefix]: value },
          provided: {},
          failures: {},
          settled: ready,
        }}
        daemon={daemon}
        ferretId="ferret-a"
        {...extra}
      />
    </Profiler>
  );
}

/** A host that has already answered: nothing in flight, the family already published. */
const answered = (prefix: ReferenceCatalogPrefix, entries: readonly ReferenceCatalogEntry[]) => ({
  entries: { [prefix]: entries },
  provided: {},
  failures: {},
  settled: () => undefined,
});

/** A promise the test resolves, at the moment the test chooses. */
function deferred(): {
  readonly read: Promise<readonly ReferenceCatalogEntry[]>;
  deliver: (entries: readonly ReferenceCatalogEntry[]) => void;
} {
  let deliver: (entries: readonly ReferenceCatalogEntry[]) => void = () => undefined;
  const read = new Promise<readonly ReferenceCatalogEntry[]>(resolve => {
    deliver = resolve;
  });
  return { read, deliver: entries => deliver(entries) };
}

describe('composer host warm-up handshake', () => {
  test('never publishes a ready skills menu about a catalog the host has already answered with', async () => {
    const { read, deliver } = deferred();
    const frames: MenuFrame[] = [];
    const holder: { view?: ReactTestRenderer } = {};
    holder.view = mounted(
      withClient(
        <CatalogHost
          onCommit={() => {
            if (holder.view !== undefined) frames.push(sampleMenu(holder.view, 'Skills'));
          }}
          prefix="$"
          read={read}
        />,
        CLIENT,
      ),
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
    expect(firstReady.text).not.toContain('have not been read for this ferret yet');
    expect(firstReady.rows).toBeGreaterThan(0);
    // And the host's answer stayed the only answer: no second read for a
    // fact that was already being read.
    expect(reads.filter(read => read.prefix === '$' || read.prefix === '/')).toEqual([]);
  });

  test('never publishes a ready attention menu that invents an empty family', async () => {
    const { read, deliver } = deferred();
    const frames: MenuFrame[] = [];
    const holder: { view?: ReactTestRenderer } = {};
    holder.view = mounted(
      withClient(
        <CatalogHost
          onCommit={() => {
            if (holder.view !== undefined) frames.push(sampleMenu(holder.view, 'References'));
          }}
          prefix="!"
          read={read}
        />,
        CLIENT,
      ),
    );
    const view = holder.view;

    type(view, '@@@A3');
    frames.length = 0;
    await runAsync(async () => {
      deliver(AGENDA);
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

  test('never publishes a ready tasks menu that invents an empty family, on the ladder or the sigil', async () => {
    for (const draft of ['@@@@F1', '&F1']) {
      const { read, deliver } = deferred();
      const frames: MenuFrame[] = [];
      const holder: { view?: ReactTestRenderer } = {};
      holder.view = mounted(
        withClient(
          <CatalogHost
            extra={{ suggestions: composerSuggestionSwitches('both', true) }}
            onCommit={() => {
              if (holder.view !== undefined)
                frames.push(sampleMenu(holder.view, draft === '&F1' ? 'Tasks' : 'References', 'task'));
            }}
            prefix="&"
            read={read}
          />,
          CLIENT,
        ),
      );
      const view = holder.view;

      type(view, draft);
      frames.length = 0;
      await runAsync(async () => {
        deliver(TASKS);
        await drain();
      });

      const firstReady = frames.find(isReady);
      if (firstReady === undefined) throw new Error('the menu never settled');
      expect(firstReady.rows).toBeGreaterThan(0);
      expect(frames.filter(isReady).every(frame => frame.rows > 0)).toBe(true);
    }
  });

  test('still answers when the host has nothing in flight to wait for', async () => {
    const settled = mounted(
      withClient(
        <Composer api={api} referenceCatalogs={answered('$', CATALOG)} daemon={daemon} ferretId="ferret-a" />,
        CLIENT,
      ),
    );

    type(settled, '$sum');
    await runAsync(drain);

    // No readiness promise at all. The handshake must not invent a wait, or a
    // host that finished before the menu opened would never get an answer.
    expect(sampleMenu(settled, 'Skills').rows).toBeGreaterThan(0);
  });
});
