import { describe, it } from 'bun:test';
import should from 'should';
import { Composer } from '../../src/components/composer.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { quoteSelectionIntoComposer } from '../../src/lib/quote.ts';
import { interact, mount, must } from '../support/dom.ts';

/**
 * The composer grows to its draft, in a real DOM.
 *
 * This is not a renderable-tree fact: the height is measured from `scrollHeight`
 * and written to `style.height` in a layout effect, so only a mounted DOM can
 * say whether a two-line draft is visible or sliced. The shipped box was one
 * 44px row with the textarea scrolling internally, which is exactly how line two
 * of a draft disappeared behind the actions row at both viewports (measured
 * 2026-08-04, 390x844 and 1440x900).
 *
 * happy-dom reports `scrollHeight` as 0 for every element, so each case states
 * the measurement it is about by defining that property. What is under test is
 * the clamp and the overflow decision, and both are asserted. The draft is
 * changed through `quoteSelectionIntoComposer` — a real production path into the
 * composer's own `replaceDraft` — rather than by poking the DOM value, so the
 * React state change that drives the effect is a real one.
 */

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.example.test',
  deviceToken: 'token-a',
});

/** Drafts must not leak between cases through a shared browser store. */
const memoryStorage = (): DraftStorage => {
  const entries = new Map<string, string>();
  return {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
};

const api = { send: async () => ({}) as never };

const textareaOf = (container: HTMLElement): HTMLTextAreaElement =>
  must(container.querySelector('textarea'), 'the composer textarea');

/**
 * Pin what the browser would have measured. The effect sets `height: auto`
 * first and then reads this, so a fixed number models a draft that renders at
 * exactly that height.
 */
const measure = (input: HTMLTextAreaElement, contentHeight: number): void => {
  Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => contentHeight });
};

/** Mount a composer, pin its measured height, then put a draft in it. */
const grown = async (options: {
  readonly compact?: boolean;
  readonly contentHeight: number;
  readonly sessionId: string;
}): Promise<{ readonly input: HTMLTextAreaElement; readonly unmount: () => Promise<void> }> => {
  const drafts = new DaemonDraftStore(memoryStorage());
  const view = await mount(
    <Composer
      api={api}
      {...(options.compact === undefined ? {} : { compact: options.compact })}
      daemon={daemon}
      draftStore={drafts}
      sessionId={options.sessionId}
    />,
  );
  const input = textareaOf(view.container);
  measure(input, options.contentHeight);
  await interact(() =>
    quoteSelectionIntoComposer('a drafted line', { daemonId: daemon.daemonId, sessionId: options.sessionId }),
  );
  return { input, unmount: view.unmount };
};

describe('composer auto-grow', () => {
  it('grows to a multi-line draft instead of scrolling it out of sight', async () => {
    const { input, unmount } = await grown({ contentHeight: 96, sessionId: 'grow' });
    try {
      // The box is the content's height, so every line the reader typed is on
      // screen — and no scrollbar, because nothing is hidden.
      should(input.style.height).equal('96px');
      should(input.style.overflowY).equal('hidden');
    } finally {
      await unmount();
    }
  });

  it('never shrinks below the 44px touch floor', async () => {
    const { input, unmount } = await grown({ contentHeight: 12, sessionId: 'floor' });
    try {
      // The floor is the target size, and it is the same 44px the stylesheet
      // declares — a one-word draft must not produce a box a thumb cannot hit.
      should(input.style.height).equal('44px');
    } finally {
      await unmount();
    }
  });

  it('caps a pasted essay and only then hands the textarea its own scrollbar', async () => {
    const { input, unmount } = await grown({ contentHeight: 4_000, sessionId: 'cap' });
    try {
      // Growth stops at the desktop ceiling so the conversation is not swallowed,
      // and the scrollbar appears only at the cap — where content genuinely is
      // hidden and the reader needs a way to reach it.
      should(input.style.height).equal('148px');
      should(input.style.overflowY).equal('auto');
    } finally {
      await unmount();
    }
  });

  it('gives a phone a taller ceiling than a desktop, because its lines are shorter', async () => {
    const { input, unmount } = await grown({ compact: true, contentHeight: 4_000, sessionId: 'phone' });
    try {
      should(input.style.height).equal('160px');
      should(input.style.overflowY).equal('auto');
    } finally {
      await unmount();
    }
  });

  it('drops the phone ceiling while the software keyboard is up', async () => {
    document.documentElement.setAttribute('data-keyboard', 'open');
    const { input, unmount } = await grown({ compact: true, contentHeight: 4_000, sessionId: 'keyboard' });
    try {
      // With ~430px of visible viewport, 160px of composer is more than a third
      // of everything the reader can see, so the ceiling comes down with the
      // keyboard — and the dependency on it is what brings it back up.
      should(input.style.height).equal('140px');
    } finally {
      await unmount();
      document.documentElement.removeAttribute('data-keyboard');
    }
  });
});
