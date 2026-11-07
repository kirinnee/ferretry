/**
 * A textarea may refuse to place a caret — it can be detached, hidden or mid-teardown, and the DOM
 * answers with an exception. The caret is a nicety on every programmatic edit: the words still have
 * to land and the composer has to keep working. These cases give the composer a textarea whose
 * `setSelectionRange` always throws and assert the draft, the focus and the mode survive.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ReactTestRenderer } from 'react-test-renderer';
import { Composer, type ComposerProps } from '../../../../app/composer/composer.tsx';
import { daemonConnection } from '../../../../app/composer/seam.ts';
import { writeMdComposePref } from '@ferretry/app';
import { composerQuoteTarget } from '@ferretry/app';
import { ensureDom } from '@ferretry/app/testing';
ensureDom();
import { render, run } from '@ferretry/app/testing';

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

/** A textarea that mirrors the controlled value, counts focus, and refuses every caret placement. */
const mountRefusing = (props: Partial<ComposerProps> = {}) => {
  const attempts: Array<readonly [number, number]> = [];
  const focuses = { count: 0 };
  let view: ReactTestRenderer | undefined;
  const element = {
    get value(): string {
      return view === undefined ? '' : String(view.root.findByType('textarea').props.value);
    },
    selectionStart: 0,
    selectionEnd: 0,
    style: {},
    focus: () => {
      focuses.count += 1;
    },
    setSelectionRange(start: number, end: number): void {
      attempts.push([start, end]);
      throw new DOMException('The textarea cannot hold a selection right now.', 'InvalidStateError');
    },
  };
  view = render(<Composer api={api} daemon={daemon} ferretId="session-refused" {...props} />, {
    createNodeMock: node => (node.type === 'textarea' ? element : null),
  });
  renderers.push(view);
  return { view, attempts, focuses };
};

const textarea = (view: ReactTestRenderer) => view.root.findByType('textarea');
const draftOf = (view: ReactTestRenderer): string => String(textarea(view).props.value);

const type = (view: ReactTestRenderer, value: string): void => {
  run(() =>
    textarea(view).props.onChange({
      currentTarget: { value, selectionStart: value.length, selectionEnd: value.length },
    }),
  );
};

const modeOf = (view: ReactTestRenderer): unknown =>
  view.root.findAll(node => node.props['data-composer-vim-mode'] !== undefined)[0]?.props['data-composer-vim-mode'];

const scope = { daemonId: daemon.daemonId, ferretId: 'session-refused' };

describe('composer when the textarea refuses a caret', () => {
  test('takes a delivered draft that equals the current one and still focuses', () => {
    const { view, attempts, focuses } = mountRefusing();
    type(view, 'quoted');
    const target = composerQuoteTarget(scope);

    expect(() => run(() => target?.replaceDraft('quoted'))).not.toThrow();

    expect(draftOf(view)).toBe('quoted');
    expect(focuses.count).toBe(1);
    expect(attempts).toContainEqual([6, 6]);
  });

  test('takes a delivered draft that changes the text and still lands every word', () => {
    const { view, attempts } = mountRefusing();
    type(view, 'old');
    const target = composerQuoteTarget(scope);

    expect(() => run(() => target?.replaceDraft('> new quote\n\n'))).not.toThrow();

    expect(draftOf(view)).toBe('> new quote\n\n');
    expect(attempts).toContainEqual([13, 13]);
  });

  test('keeps Vim in normal mode through a movement whose caret the textarea refuses', () => {
    const { view, attempts } = mountRefusing({ vimMode: true });
    type(view, 'alpha beta');
    const press = (key: string, caret: number): void =>
      run(() =>
        textarea(view).props.onKeyDown({
          key,
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          nativeEvent: { isComposing: false },
          currentTarget: { value: draftOf(view), selectionStart: caret, selectionEnd: caret },
          preventDefault: () => undefined,
        }),
      );
    press('Escape', 6);
    const before = attempts.length;

    expect(() => press('h', 6)).not.toThrow();

    expect(attempts.length).toBeGreaterThan(before);
    expect(draftOf(view)).toBe('alpha beta');
    expect(modeOf(view)).toBe('normal');
  });
});
