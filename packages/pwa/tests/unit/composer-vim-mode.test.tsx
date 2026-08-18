/**
 * The composer's key arbitration, with a modal editor in it.
 *
 * Every assertion here is about ORDER, because order is the whole design: an
 * input method outranks everything, an open suggestion list outranks the editor,
 * the editor outranks the send policy, and anything none of them claimed keeps
 * its browser meaning. The engine itself is pure and tested separately; what is
 * tested here is the host that decides who gets each key, and the five moments
 * that must put a reader back in insert mode.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactTestRenderer } from 'react-test-renderer';
import { Composer as ProductionComposer, type ComposerProps } from '../../src/components/composer.tsx';
import { DictationControl } from '../../src/components/dictation-control.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { composerQuoteTarget } from '../../src/lib/quote.ts';
import { DEFAULT_STT_SETTINGS } from '../../src/lib/stt/stt-settings.ts';
import type { DaemonFetch } from '../../src/lib/runtime-models.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';

const renderers: ReactTestRenderer[] = [];
afterEach(() => {
  run(() => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
});

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.example.test',
  deviceToken: 'token-a',
});

const api = { send: async () => undefined } as never;
/** Keyboard arbitration has no daemon dependency; keep autocomplete local. */
const autocompleteFetch: DaemonFetch = async () => Response.json({}, { status: 500 });
const Composer = (props: ComposerProps) => <ProductionComposer {...props} autocompleteFetcher={autocompleteFetch} />;

interface KeyOptions {
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
  readonly caret?: number;
}

const mounted = (element: Parameters<typeof render>[0], options?: Parameters<typeof render>[1]): ReactTestRenderer => {
  const renderer = render(element, options);
  renderers.push(renderer);
  return renderer;
};

const textarea = (view: ReactTestRenderer) => view.root.findByType('textarea');
const draftOf = (view: ReactTestRenderer): string => String(textarea(view).props.value);

const type = (view: ReactTestRenderer, value: string, caret = value.length): void => {
  run(() => textarea(view).props.onChange({ currentTarget: { value, selectionStart: caret, selectionEnd: caret } }));
};

/** One keydown, with the exact evidence the composer reads from a real event. */
const press = (view: ReactTestRenderer, key: string, options: KeyOptions = {}): boolean => {
  let prevented = false;
  const caret = options.caret ?? draftOf(view).length;
  run(() =>
    textarea(view).props.onKeyDown({
      key,
      ctrlKey: options.ctrlKey ?? false,
      metaKey: false,
      altKey: false,
      shiftKey: options.shiftKey ?? false,
      nativeEvent: { isComposing: options.isComposing ?? false },
      currentTarget: { value: draftOf(view), selectionStart: caret, selectionEnd: caret },
      preventDefault: () => {
        prevented = true;
      },
    }),
  );
  return prevented;
};

const modeButton = (view: ReactTestRenderer) => view.root.findByProps({ 'data-composer-vim-mode': 'insert' });
const modeOf = (view: ReactTestRenderer): string =>
  String(
    view.root.findAll(node => node.props['data-composer-vim-mode'] !== undefined)[0]?.props['data-composer-vim-mode'],
  );

describe('composer Vim adapter', () => {
  test('is absent, and changes nothing, until the reader asks for it', () => {
    const view = mounted(<Composer api={api} daemon={daemon} sessionId="session-a" />);

    type(view, 'hello');
    // No indicator, and Escape is nobody's key: it neither prevents nor edits.
    expect(view.root.findAll(node => node.props['data-composer-vim-mode'] !== undefined)).toHaveLength(0);
    expect(press(view, 'Escape')).toBe(false);
    expect(draftOf(view)).toBe('hello');
  });

  test('opens in insert mode, leaves it on Escape, and edits from normal mode', () => {
    const view = mounted(<Composer api={api} daemon={daemon} sessionId="session-a" vimMode />);

    type(view, 'alpha beta');
    expect(modeOf(view)).toBe('insert');

    expect(press(view, 'Escape')).toBe(true);
    expect(modeOf(view)).toBe('normal');
    // `x` deletes the character under the caret, through the controlled draft.
    expect(press(view, 'x', { caret: 9 })).toBe(true);
    expect(draftOf(view)).toBe('alpha bet');
    // `i` returns to insert, and an ordinary letter is text again.
    expect(press(view, 'i', { caret: 8 })).toBe(true);
    expect(modeOf(view)).toBe('insert');
    expect(press(view, 'x')).toBe(false);
  });

  test('never claims a key it did not act on, so system shortcuts survive normal mode', () => {
    const view = mounted(<Composer api={api} daemon={daemon} sessionId="session-a" vimMode />);

    type(view, 'alpha');
    press(view, 'Escape');
    expect(modeOf(view)).toBe('normal');
    // Ctrl/Meta/Alt keys and the navigation keys belong to the platform.
    expect(press(view, 'a', { ctrlKey: true })).toBe(false);
    expect(press(view, 'ArrowLeft')).toBe(false);
    expect(press(view, 'Backspace')).toBe(false);
    expect(draftOf(view)).toBe('alpha');
  });

  test('keeps the send policy in normal mode, because the engine never claims Enter', () => {
    let sent = 0;
    const view = mounted(
      <Composer
        api={
          {
            send: async () => {
              sent += 1;
            },
          } as never
        }
        daemon={daemon}
        enterKeyPreference="send"
        sessionId="session-a"
        vimMode
      />,
    );

    type(view, 'ship it');
    press(view, 'Escape');
    expect(modeOf(view)).toBe('normal');
    expect(press(view, 'Enter')).toBe(true);
    expect(sent).toBe(1);
  });

  test('gives the open suggestion list the first Escape and the editor the second', () => {
    const view = mounted(<Composer api={api} daemon={daemon} sessionId="session-a" vimMode />);

    // `@` opens the files list against a daemon that never answers, but the
    // controller is open from the first keystroke, which is what arbitrates.
    type(view, '@');
    expect(textarea(view).props['aria-expanded']).toBe(true);
    expect(press(view, 'Escape')).toBe(true);
    // The list closed and the reader is still typing text.
    expect(textarea(view).props['aria-expanded']).toBeUndefined();
    expect(modeOf(view)).toBe('insert');

    expect(press(view, 'Escape')).toBe(true);
    expect(modeOf(view)).toBe('normal');
  });

  test('lets no composing key reach the editor, the list, or the send policy', () => {
    let sent = 0;
    const view = mounted(
      <Composer
        api={
          {
            send: async () => {
              sent += 1;
            },
          } as never
        }
        daemon={daemon}
        enterKeyPreference="send"
        sessionId="session-a"
        vimMode
      />,
    );

    type(view, 'かんじ');
    // A composition is a state as well as a per-key flag: both are refused.
    run(() => textarea(view).props.onCompositionStart());
    expect(press(view, 'Escape')).toBe(false);
    expect(modeOf(view)).toBe('insert');
    expect(press(view, 'Enter')).toBe(false);
    expect(sent).toBe(0);

    run(() =>
      textarea(view).props.onCompositionEnd({ currentTarget: { value: 'かんじ', selectionStart: 3, selectionEnd: 3 } }),
    );
    // And once it ends, the same keys are the reader's again.
    expect(press(view, 'Escape', { isComposing: true })).toBe(false);
    expect(press(view, 'Escape')).toBe(true);
    expect(modeOf(view)).toBe('normal');
  });

  test('announces the mode in words and offers a 44px toggle for a reader with no Escape key', () => {
    const view = mounted(<Composer api={api} daemon={daemon} sessionId="session-a" vimMode />);

    const announcer = view.root.findAll(
      node => node.props['aria-live'] === 'polite' && String(node.props.className).includes('sr-only'),
    );
    expect(announcer.some(node => node.children.includes('Insert mode'))).toBe(true);

    const toggle = modeButton(view);
    expect(String(toggle.props.className)).toContain('min-h-[44px]');
    expect(String(toggle.props.className)).toContain('min-w-[44px]');
    expect(toggle.props['aria-label']).toBe('Vim Insert mode. Switch to Normal mode');
    expect(toggle.children).toEqual(['Insert']);

    run(() => toggle.props.onClick());
    expect(modeOf(view)).toBe('normal');
    expect(view.root.findByProps({ 'data-composer-vim-mode': 'normal' }).children).toEqual(['Normal']);
  });

  test('puts the caret back into the element, after the value that carries it', () => {
    // The caret is written in a layout effect, once the controlled value has
    // actually landed: writing it earlier would place it in the OLD text and
    // the browser would clamp it somewhere else. A host ref is null in this
    // renderer unless one is supplied, so the element is supplied — otherwise
    // the effect silently never runs and the coverage would be a lie.
    const writes: Array<{ readonly value: string; readonly start: number }> = [];
    let view: ReactTestRenderer | undefined;
    // The element MIRRORS the controlled value, exactly as a real textarea does
    // once React has committed it. That mirroring is the whole point: the effect
    // refuses to place a caret until the element holds the text the caret was
    // computed against, and a mock frozen at the old text would never get there.
    const element = {
      get value(): string {
        return view === undefined ? '' : String(view.root.findByType('textarea').props.value);
      },
      selectionStart: 0,
      selectionEnd: 0,
      style: {},
      focus: () => undefined,
      setSelectionRange(start: number): void {
        writes.push({ value: this.value, start });
      },
    };
    view = mounted(<Composer api={api} daemon={daemon} sessionId="session-caret" vimMode />, {
      createNodeMock: node => (node.type === 'textarea' ? element : null),
    });

    type(view, 'alpha beta');
    press(view, 'Escape', { caret: 6 });
    press(view, 'x', { caret: 6 });

    expect(draftOf(view)).toBe('alpha eta');
    // Every caret write landed in the text it was computed for — never in the
    // previous value, which is the bug this ordering exists to prevent — and
    // the last one is the deletion's own answer.
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every(write => write.start <= write.value.length)).toBe(true);
    expect(writes.at(-1)?.value).toBe('alpha eta');
  });

  describe('every path back to insert mode', () => {
    const inNormalMode = (props: Record<string, unknown> = {}): ReactTestRenderer => {
      const view = mounted(<Composer api={api} daemon={daemon} sessionId="session-a" vimMode {...props} />);
      type(view, 'alpha');
      press(view, 'Escape');
      expect(modeOf(view)).toBe('normal');
      return view;
    };

    test('a session change', () => {
      const view = inNormalMode();
      run(() => view.update(<Composer api={api} daemon={daemon} sessionId="session-b" vimMode />));
      expect(modeOf(view)).toBe('insert');
    });

    test('a successful send', async () => {
      const view = inNormalMode({ enterKeyPreference: 'send' });
      await runAsync(async () => {
        textarea(view).props.onKeyDown({
          key: 'Enter',
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          nativeEvent: { isComposing: false },
          currentTarget: { value: 'alpha', selectionStart: 5, selectionEnd: 5 },
          preventDefault: () => undefined,
        });
        await Promise.resolve();
      });
      expect(draftOf(view)).toBe('');
      expect(modeOf(view)).toBe('insert');
    });

    test('a quote or Add-to-chat delivery', () => {
      const view = inNormalMode({});
      const target = composerQuoteTarget({ daemonId: daemon.daemonId, sessionId: 'session-a' });
      run(() => target?.replaceDraft('> quoted\n\n'));
      expect(draftOf(view)).toBe('> quoted\n\n');
      expect(modeOf(view)).toBe('insert');
    });

    test('dictation, before the spoken words land', () => {
      const view = mounted(
        <Composer api={api} daemon={daemon} dictationSettings={DEFAULT_STT_SETTINGS} sessionId="session-a" vimMode />,
      );
      type(view, 'alpha');
      press(view, 'Escape');
      expect(modeOf(view)).toBe('normal');

      // The composer's own dictation seam, as the mounted control calls it.
      // Spoken words are inserted AT the caret, and a normal-mode caret sits ON
      // a character rather than between two — so the mode has to be back to
      // insert before the text lands, not after.
      run(() => view.root.findByType(DictationControl).props.onDraftChange({ text: 'alpha spoken', caret: 12 }));

      expect(modeOf(view)).toBe('insert');
      expect(draftOf(view)).toBe('alpha spoken');
    });

    test('the preference being turned off', () => {
      const view = inNormalMode();
      run(() => view.update(<Composer api={api} daemon={daemon} sessionId="session-a" vimMode={false} />));
      expect(view.root.findAll(node => node.props['data-composer-vim-mode'] !== undefined)).toHaveLength(0);
      run(() => view.update(<Composer api={api} daemon={daemon} sessionId="session-a" vimMode />));
      expect(modeOf(view)).toBe('insert');
    });
  });
});
