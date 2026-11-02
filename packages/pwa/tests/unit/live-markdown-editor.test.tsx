import { afterEach, describe, expect, test } from 'bun:test';
import { useState } from 'react';
import {
  type LiveFieldHandle,
  type LiveKeyEvent,
  LiveMarkdownEditor,
  type LiveMarkers,
  liveOffset,
  livePosition,
  readLiveDocument,
  renderLiveDocument,
} from '../../src/components/live-markdown-editor.tsx';
import '../support/dom.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

const rendered = (value: string, markers: LiveMarkers = 'faint', caret: number | null = null): HTMLElement => {
  const root = document.createElement('div');
  renderLiveDocument(root, value, { markers, caret });
  return root;
};

// Every test here places a document selection; a later suite must not start inside one.
afterEach(() => {
  document.getSelection()?.removeAllRanges();
});

describe('renderLiveDocument', () => {
  test('keeps every character as text, one element per line, and paints each line by its kind', () => {
    const root = rendered('# Title\n- **b**\n\n```\nx');
    expect(readLiveDocument(root)).toBe('# Title\n- **b**\n\n```\nx');
    expect(Array.from(root.children).map(line => line.getAttribute('data-block'))).toEqual([
      'h1',
      'bullet',
      'p',
      'fence',
      'code',
    ]);
    expect(root.querySelector('[data-md-marker="h1"]')?.textContent).toBe('# ');
    expect(root.querySelector('[data-md="strong"]:not([data-md-mark])')?.textContent).toBe('b');
    expect(root.children[2]?.querySelector('br')).not.toBeNull();
    expect(root.hasAttribute('data-empty')).toBe(false);
    expect(rendered('').hasAttribute('data-empty')).toBe(true);
  });

  test('draws checklist state, keeps a list indent as text and marks fences and rules as syntax', () => {
    const root = rendered('  - [x] done\n---\n```');
    expect(root.querySelector('[data-md-marker="check"]')?.getAttribute('data-checked')).toBe('true');
    expect(root.children[0]?.firstChild?.textContent).toBe('  ');
    expect(root.children[1]?.querySelector('[data-md-mark]')?.textContent).toBe('---');
    expect(root.children[2]?.querySelector('[data-md-mark]')?.textContent).toBe('```');
  });

  test('hides heading, quote and inline markers in the hidden style, except on the caret’s line', () => {
    const root = rendered('# One\n> **two**', 'hidden', 0);
    expect(root.children[0]?.querySelectorAll('[data-md-hidden]')).toHaveLength(0);
    expect(
      Array.from(root.children[1]?.querySelectorAll('[data-md-hidden]') ?? []).map(node => node.textContent),
    ).toEqual(['> ', '**', '**']);
    expect(rendered('# One', 'hidden', null).querySelectorAll('[data-md-hidden]')).toHaveLength(1);
  });
});

describe('reading the document back', () => {
  test('treats text the browser put straight into the root as part of the line it sits on', () => {
    const root = document.createElement('div');
    root.append('a', document.createElement('span'), 'b');
    root.lastChild?.before(document.createElement('br'));
    const line = document.createElement('p');
    line.textContent = 'c d';
    root.append(document.createElement('br'), document.createElement('br'), line);
    expect(readLiveDocument(root)).toBe('a\nb\n\nc d');
  });

  test('drops zero-width fillers and reads a non-breaking space as a space', () => {
    const root = document.createElement('div');
    const line = document.createElement('div');
    line.textContent = 'a b​';
    root.append(line);
    expect(readLiveDocument(root)).toBe('a b');
  });
});

describe('offsets', () => {
  test('a DOM position becomes a draft offset, newlines included', () => {
    const root = rendered('ab\n**cd**');
    const second = root.children[1] as HTMLElement;
    const word = must(second.querySelector('[data-md="strong"]:not([data-md-mark])')?.firstChild, 'the word');
    expect(liveOffset(root, word, 1)).toBe(6);
    expect(liveOffset(root, root, 1)).toBe(3);
    expect(liveOffset(root, root, 5)).toBe(9);
    expect(liveOffset(root, document.createElement('i'), 0)).toBe(9);
  });

  test('an offset becomes a DOM position, preferring visible text at a boundary', () => {
    const root = rendered('ab\n# cd\n', 'hidden', 0);
    expect(livePosition(root, 1)).toEqual({ node: must(root.children[0]?.firstChild, 'ab'), offset: 1 });
    // On a line whose marker is hidden, offset 5 is after `# ` — the caret goes into the words.
    const words = must(root.children[1]?.lastChild, 'cd');
    expect(livePosition(root, 5)).toEqual({ node: words, offset: 0 });
    expect(livePosition(root, 7)).toEqual({ node: words, offset: 2 });
    expect(livePosition(root, 8)).toEqual({ node: must(root.children[2], 'the empty line'), offset: 0 });
    expect(livePosition(root, 99)).toEqual({ node: must(root.children[2], 'the empty line'), offset: 0 });
    expect(livePosition(document.createElement('div'), 3)).toEqual({ node: expect.anything(), offset: 0 });
    const past = rendered('ab');
    expect(livePosition(past, 99)).toEqual({ node: must(past.firstChild?.firstChild, 'ab'), offset: 2 });
  });
});

interface Probe {
  readonly view: Mounted;
  readonly element: HTMLElement;
  readonly field: () => LiveFieldHandle;
  readonly value: () => string;
  readonly keys: LiveKeyEvent[];
  readonly selects: number[];
  readonly composition: string[];
  rerender(props: {
    readonly markers?: LiveMarkers;
    readonly disabled?: boolean;
    readonly value?: string;
  }): Promise<void>;
}

/** The editor under a host that owns its value, exactly as the composer does. */
const probe = async (
  initial: string,
  options: {
    readonly markers?: LiveMarkers;
    readonly disabled?: boolean;
    readonly onKeyDown?: (event: LiveKeyEvent) => void;
    readonly preventPaste?: boolean;
  } = {},
): Promise<Probe> => {
  let handle: LiveFieldHandle | null = null;
  let current = initial;
  const keys: LiveKeyEvent[] = [];
  const selects: number[] = [];
  const composition: string[] = [];
  let setExternal: (value: string) => void = () => undefined;
  const elementRef = { current: null as HTMLElement | null };
  function Host({ markers, disabled }: { readonly markers: LiveMarkers; readonly disabled: boolean }) {
    const [value, setValue] = useState(initial);
    current = value;
    setExternal = setValue;
    return (
      <LiveMarkdownEditor
        disabled={disabled}
        elementRef={elementRef}
        fieldRef={next => {
          handle = next;
        }}
        id="probe"
        markers={markers}
        maxHeight={100}
        onChange={event => setValue(event.currentTarget.value)}
        onCompositionEnd={event => composition.push(`end:${event.currentTarget.value}`)}
        onCompositionStart={() => composition.push('start')}
        onKeyDown={event => {
          keys.push(event);
          options.onKeyDown?.(event);
        }}
        onPaste={event => {
          if (options.preventPaste === true) event.preventDefault();
        }}
        onSelect={event => selects.push(event.currentTarget.selectionStart)}
        placeholder="Message"
        value={value}
        vimMode="normal"
      />
    );
  }
  const view = await mount(<Host disabled={options.disabled ?? false} markers={options.markers ?? 'faint'} />);
  const element = must(view.container.querySelector<HTMLElement>('[data-live-editor]'), 'the editor');
  expect(elementRef.current).toBe(element);
  return {
    view,
    element,
    field: () => must(handle, 'the field handle'),
    value: () => current,
    keys,
    selects,
    composition,
    async rerender(props) {
      if (props.value !== undefined) {
        const next = props.value;
        await interact(() => setExternal(next));
      }
      await view.render(
        <Host
          disabled={props.disabled ?? options.disabled ?? false}
          markers={props.markers ?? options.markers ?? 'faint'}
        />,
      );
    },
  };
};

/** A `beforeinput` the way the platform sends one. */
const beforeInput = async (
  element: HTMLElement,
  inputType: string,
  init: {
    readonly data?: string | null;
    readonly text?: string;
    readonly ranges?: readonly { startContainer: Node; startOffset: number; endContainer: Node; endOffset: number }[];
  } = {},
): Promise<boolean> => {
  const event = new Event('beforeinput', { bubbles: true, cancelable: true });
  Object.assign(event, {
    inputType,
    data: init.data ?? null,
    dataTransfer: init.text === undefined ? null : { getData: () => init.text },
    ...(init.ranges === undefined ? {} : { getTargetRanges: () => init.ranges }),
  });
  await interact(() => element.dispatchEvent(event));
  return event.defaultPrevented;
};

const keyDown = async (element: HTMLElement, init: KeyboardEventInit): Promise<boolean> => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await interact(() => element.dispatchEvent(event));
  return event.defaultPrevented;
};

const focusAt = async (editor: Probe, start: number, end = start): Promise<void> => {
  await interact(() => {
    editor.field().focus();
    editor.field().setSelectionRange(start, end);
  });
};

describe('LiveMarkdownEditor', () => {
  test('looks like a textarea to its host: value, selection, focus and containment', async () => {
    const editor = await probe('hello');
    const field = editor.field();
    expect(field.value).toBe('hello');
    expect(editor.element.getAttribute('data-vim')).toBe('normal');
    expect(editor.element.style.maxHeight).toBe('100px');
    // Unfocused, the selection is remembered rather than placed.
    field.setSelectionRange(1, 99);
    expect([field.selectionStart, field.selectionEnd]).toEqual([1, 5]);
    await interact(() => field.focus());
    expect(document.activeElement).toBe(editor.element);
    expect([field.selectionStart, field.selectionEnd]).toEqual([1, 5]);
    expect(field.contains(editor.element.firstChild)).toBe(true);
    expect(field.contains(document.body)).toBe(false);
    await editor.view.unmount();
    expect(() => editor.field()).toThrow();
  });

  test('typing, a line break and a paste are edits of the source, with the caret after them', async () => {
    const editor = await probe('ab');
    await focusAt(editor, 1);
    expect(await beforeInput(editor.element, 'insertText', { data: '#' })).toBe(true);
    expect(editor.value()).toBe('a#b');
    expect(await beforeInput(editor.element, 'insertParagraph')).toBe(true);
    expect(editor.value()).toBe('a#\nb');
    expect(editor.field().selectionStart).toBe(3);
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.assign(paste, { clipboardData: { files: [], getData: () => '**x**' } });
    await interact(() => editor.element.dispatchEvent(paste));
    expect(editor.value()).toBe('a#\n**x**b');
    expect(editor.element.querySelector('[data-md="strong"]')).not.toBeNull();
    // A spelling fix and a drop name their own range.
    const first = must(editor.element.firstChild?.firstChild, 'a#');
    await beforeInput(editor.element, 'insertReplacementText', {
      text: 'A',
      ranges: [{ startContainer: first, startOffset: 0, endContainer: first, endOffset: 1 }],
    });
    expect(editor.value()).toBe('A#\n**x**b');
    await beforeInput(editor.element, 'insertFromDrop', {});
    expect(editor.value()).toBe('A#\n**x**b');
  });

  test('a paste the host claimed (files) inserts nothing', async () => {
    const editor = await probe('ab', { preventPaste: true });
    await focusAt(editor, 1);
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.assign(paste, { clipboardData: null });
    await interact(() => editor.element.dispatchEvent(paste));
    expect(editor.value()).toBe('ab');
  });

  test('deletes by the platform’s target range, or by one code point when it names none', async () => {
    const editor = await probe('a😀bc');
    await focusAt(editor, 3);
    await beforeInput(editor.element, 'deleteContentBackward');
    expect(editor.value()).toBe('abc');
    await focusAt(editor, 1);
    await beforeInput(editor.element, 'deleteContentForward');
    expect(editor.value()).toBe('ac');
    await interact(() => editor.field().setSelectionRange(0, 0));
    await beforeInput(editor.element, 'deleteContentBackward');
    expect(editor.value()).toBe('ac');
    await interact(() => editor.field().setSelectionRange(2, 2));
    await beforeInput(editor.element, 'deleteContentForward');
    expect(editor.value()).toBe('ac');
    await rerenderValue(editor, '😀x');
    await focusAt(editor, 0);
    await beforeInput(editor.element, 'deleteContentForward');
    expect(editor.value()).toBe('x');
    await rerenderValue(editor, 'one two');
    await focusAt(editor, 7);
    const text = must(editor.element.firstChild?.firstChild, 'one two');
    await beforeInput(editor.element, 'deleteWordBackward', {
      ranges: [{ startContainer: text, startOffset: 4, endContainer: text, endOffset: 7 }],
    });
    expect(editor.value()).toBe('one ');
    // A selection outranks a collapsed target range.
    await focusAt(editor, 0, 3);
    await beforeInput(editor.element, 'deleteByCut', {
      ranges: [{ startContainer: text, startOffset: 0, endContainer: text, endOffset: 0 }],
    });
    expect(editor.value()).toBe(' ');
  });

  test('Backspace at the start of a heading’s words turns it back into a paragraph', async () => {
    const editor = await probe('## Title');
    await focusAt(editor, 3);
    await beforeInput(editor.element, 'deleteContentBackward');
    expect(editor.value()).toBe('Title');
    expect(editor.field().selectionStart).toBe(0);
  });

  test('undo and redo walk the editor’s own history, typed runs as one step', async () => {
    const editor = await probe('');
    await focusAt(editor, 0);
    for (const data of ['a', 'b']) await beforeInput(editor.element, 'insertText', { data });
    await beforeInput(editor.element, 'insertText', { data: ' ' });
    await beforeInput(editor.element, 'insertText', { data: 'c' });
    expect(editor.value()).toBe('ab c');
    expect(await keyDown(editor.element, { key: 'z', metaKey: true })).toBe(true);
    expect(editor.value()).toBe('ab ');
    await beforeInput(editor.element, 'historyUndo');
    expect(editor.value()).toBe('ab');
    await keyDown(editor.element, { key: 'z', ctrlKey: true });
    expect(editor.value()).toBe('');
    await keyDown(editor.element, { key: 'z', ctrlKey: true });
    expect(editor.value()).toBe('');
    await keyDown(editor.element, { key: 'Z', metaKey: true, shiftKey: true });
    await beforeInput(editor.element, 'historyRedo');
    await keyDown(editor.element, { key: 'y', ctrlKey: true });
    expect(editor.value()).toBe('ab c');
    // A change the host makes is a step too.
    await rerenderValue(editor, 'replaced');
    await keyDown(editor.element, { key: 'z', ctrlKey: true });
    expect(editor.value()).toBe('ab c');
  });

  test('native format commands wrap in markdown; the ones markdown has no mark for are refused', async () => {
    const editor = await probe('word');
    await focusAt(editor, 0, 4);
    await beforeInput(editor.element, 'formatBold');
    expect(editor.value()).toBe('**word**');
    expect(await beforeInput(editor.element, 'formatUnderline')).toBe(true);
    expect(editor.value()).toBe('**word**');
  });

  test('an input type it does not handle is the platform’s, read back from the document', async () => {
    const editor = await probe('ab');
    await focusAt(editor, 2);
    expect(await beforeInput(editor.element, 'insertFromYank')).toBe(false);
    must(editor.element.firstChild?.firstChild, 'ab').textContent = 'abc';
    await interact(() => editor.element.dispatchEvent(new Event('input', { bubbles: true })));
    expect(editor.value()).toBe('abc');
    // An input with nothing changed is nothing.
    await interact(() => editor.element.dispatchEvent(new Event('input', { bubbles: true })));
    expect(editor.value()).toBe('abc');
  });

  test('a composition is the input method’s until it ends, then it is read back and painted', async () => {
    const editor = await probe('a');
    await focusAt(editor, 1);
    await interact(() => editor.element.dispatchEvent(new Event('compositionstart', { bubbles: true })));
    expect(await beforeInput(editor.element, 'insertCompositionText', { data: 'に' })).toBe(false);
    expect(await beforeInput(editor.element, 'insertText', { data: 'x' })).toBe(false);
    expect(await keyDown(editor.element, { key: 'Enter' })).toBe(false);
    must(editor.element.firstChild?.firstChild, 'a').textContent = 'aに';
    await interact(() => editor.element.dispatchEvent(new Event('input', { bubbles: true })));
    expect(editor.value()).toBe('aに');
    // The host's echo of a mid-composition value repaints nothing.
    await editor.rerender({});
    must(editor.element.firstChild?.firstChild, 'aに').textContent = 'a日';
    await interact(() => editor.element.dispatchEvent(new Event('compositionend', { bubbles: true })));
    expect(editor.value()).toBe('a日');
    expect(editor.composition).toEqual(['start', 'end:a日']);
    await interact(() => editor.element.dispatchEvent(new Event('compositionstart', { bubbles: true })));
    await interact(() => editor.element.dispatchEvent(new Event('compositionend', { bubbles: true })));
    expect(editor.composition).toEqual(['start', 'end:a日', 'start', 'end:a日']);
  });

  test('Enter the host did not take is a plain new line; keys the host took are left alone', async () => {
    const editor = await probe('ab', {
      onKeyDown: event => {
        if (event.key === 'Tab') event.preventDefault();
      },
    });
    await focusAt(editor, 1);
    expect(await keyDown(editor.element, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(editor.value()).toBe('a\nb');
    expect(editor.keys.at(-1)).toMatchObject({ key: 'Enter', shiftKey: true, nativeEvent: { isComposing: false } });
    expect(await keyDown(editor.element, { key: 'Tab' })).toBe(true);
    expect(await keyDown(editor.element, { key: 'q' })).toBe(false);
    expect(await keyDown(editor.element, { key: 'Enter', metaKey: true })).toBe(false);
    expect(editor.value()).toBe('a\nb');
  });

  test('disabled, it takes no input at all', async () => {
    const editor = await probe('ab', { disabled: true });
    expect(editor.element.getAttribute('contenteditable')).toBe('false');
    expect(editor.element.getAttribute('aria-disabled')).toBe('true');
    expect(await beforeInput(editor.element, 'insertText', { data: 'x' })).toBe(true);
    await keyDown(editor.element, { key: 'Enter' });
    expect(editor.keys).toHaveLength(0);
    expect(editor.value()).toBe('ab');
  });

  test('in the hidden style, the caret’s line shows its markers and leaving hides them again', async () => {
    const editor = await probe('# One\n**two**', { markers: 'hidden' });
    expect(editor.element.querySelectorAll('[data-md-hidden]')).toHaveLength(3);
    await focusAt(editor, 8);
    await interact(() => document.dispatchEvent(new Event('selectionchange')));
    expect(editor.element.children[1]?.querySelectorAll('[data-md-hidden]')).toHaveLength(0);
    expect(editor.element.children[0]?.querySelectorAll('[data-md-hidden]')).toHaveLength(1);
    expect(editor.selects.at(-1)).toBe(8);
    // Same line again: nothing to repaint, the host still hears about the move.
    const painted = editor.element.children[1];
    await interact(() => document.dispatchEvent(new Event('selectionchange')));
    expect(editor.element.children[1]).toBe(painted);
    // A range selection never repaints under the reader's drag.
    await interact(() => editor.field().setSelectionRange(0, 3));
    await interact(() => document.dispatchEvent(new Event('selectionchange')));
    await interact(() => editor.element.blur());
    await interact(() => editor.element.dispatchEvent(new Event('blur')));
    expect(editor.element.querySelectorAll('[data-md-hidden]')).toHaveLength(3);
    // Unfocused, a selection change is somebody else's.
    const heard = editor.selects.length;
    await interact(() => document.dispatchEvent(new Event('selectionchange')));
    expect(editor.selects).toHaveLength(heard);
    await editor.rerender({ markers: 'faint' });
    expect(editor.element.querySelectorAll('[data-md-hidden]')).toHaveLength(0);
    await interact(() => editor.element.dispatchEvent(new Event('blur')));
  });

  test('a selection outside the editor is not the editor’s', async () => {
    const editor = await probe('ab');
    await focusAt(editor, 1);
    const outside = document.createElement('p');
    outside.textContent = 'elsewhere';
    document.body.append(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    await interact(() => document.dispatchEvent(new Event('selectionchange')));
    expect(editor.field().selectionStart).toBe(1);
    document.getSelection()?.removeAllRanges();
    expect(editor.field().selectionStart).toBe(1);
    outside.remove();
  });

  test('keeps the caret in view when the document outgrows its box', async () => {
    const editor = await probe('a\nb\nc');
    const original = Range.prototype.getBoundingClientRect;
    const frame = editor.element.getBoundingClientRect;
    let caretTop = 150;
    Range.prototype.getBoundingClientRect = () => ({ top: caretTop, bottom: caretTop + 20, height: 20 }) as DOMRect;
    editor.element.getBoundingClientRect = () => ({ top: 100, bottom: 160, height: 60 }) as DOMRect;
    try {
      await focusAt(editor, 4);
      const scrolled = editor.element.scrollTop;
      expect(scrolled).toBeGreaterThan(0);
      caretTop = 90;
      await focusAt(editor, 0);
      expect(editor.element.scrollTop).toBeLessThan(scrolled);
    } finally {
      Range.prototype.getBoundingClientRect = original;
      editor.element.getBoundingClientRect = frame;
    }
  });
});

const rerenderValue = async (editor: Probe, value: string): Promise<void> => {
  await editor.rerender({ value });
};

describe('a composition and the host (B135)', () => {
  /** The input method writes `text` into the first line and reports it, as a composition does. */
  const composeInto = async (editor: Probe, text: string): Promise<void> => {
    must(editor.element.firstElementChild, 'the first line').textContent = text;
    await interact(() => editor.element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })));
  };
  const start = async (editor: Probe): Promise<void> =>
    await interact(() => editor.element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  const end = async (editor: Probe): Promise<void> =>
    await interact(() => editor.element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));

  test('CJK: every step of a composition reaches the host, and the committed word is what stays', async () => {
    const editor = await probe('');
    await focusAt(editor, 0);
    await start(editor);
    await interact(() => editor.element.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'に' })));
    await composeInto(editor, 'に');
    await composeInto(editor, 'にほ');
    await composeInto(editor, 'にほん');
    expect(editor.value()).toBe('にほん');
    await composeInto(editor, '日本');
    await end(editor);
    expect(editor.value()).toBe('日本');
    expect(readLiveDocument(editor.element)).toBe('日本');
    expect(editor.composition).toEqual(['start', 'end:日本']);
  });

  test('a prediction or autocorrect that replaces the composed word is taken as typed', async () => {
    const editor = await probe('I ');
    await focusAt(editor, 2);
    await start(editor);
    await composeInto(editor, 'I teh');
    await composeInto(editor, 'I the');
    await end(editor);
    expect(editor.value()).toBe('I the');
    // The keyboard's own spelling fix after the word is committed names its range.
    expect(
      await beforeInput(editor.element, 'insertReplacementText', {
        text: 'They',
        ranges: [
          {
            startContainer: must(editor.element.firstElementChild?.firstChild, 'text'),
            startOffset: 2,
            endContainer: must(editor.element.firstElementChild?.firstChild, 'text'),
            endOffset: 5,
          },
        ],
      }),
    ).toBe(true);
    expect(editor.value()).toBe('I They');
  });

  test('a render behind the composition is an echo: it repaints nothing and the composition goes on', async () => {
    const editor = await probe('a');
    await focusAt(editor, 1);
    await start(editor);
    await composeInto(editor, 'aに');
    await composeInto(editor, 'aにほ');
    // The host is one step behind: what it holds is a text this composition already reported.
    await editor.rerender({ value: 'aに' });
    expect(readLiveDocument(editor.element)).toBe('aにほ');
    await composeInto(editor, 'aにほん');
    await end(editor);
    expect(editor.value()).toBe('aにほん');
    expect(editor.composition).toEqual(['start', 'end:aにほん']);
  });

  test('a send clearing the box mid-composition is painted, and the rest of that composition is never read back', async () => {
    const editor = await probe('hello ');
    await focusAt(editor, 6);
    await start(editor);
    await composeInto(editor, 'hello wor');
    expect(editor.value()).toBe('hello wor');

    // The send lands: the host empties the box under the composition.
    await editor.rerender({ value: '' });
    expect(readLiveDocument(editor.element)).toBe('');
    // The host is told the composition is over, so its keys are its own again.
    expect(editor.composition).toEqual(['start', 'end:']);

    // The keyboard carries on with the word it was composing: painted over, never read back.
    await composeInto(editor, 'world');
    expect(readLiveDocument(editor.element)).toBe('');
    expect(editor.value()).toBe('');
    await end(editor);
    expect(readLiveDocument(editor.element)).toBe('');
    expect(editor.value()).toBe('');
    expect(editor.composition).toEqual(['start', 'end:']);

    // The next message is typed as ever.
    await beforeInput(editor.element, 'insertText', { data: 'n' });
    expect(editor.value()).toBe('n');
  });

  test("another device's edit mid-composition lands, with what was already composed kept", async () => {
    const editor = await probe('ab');
    await focusAt(editor, 2);
    await start(editor);
    await composeInto(editor, 'abに');
    // The phone put "X " in front: the host's draft is its edit applied to what this device reported.
    await editor.rerender({ value: 'X abに' });
    expect(readLiveDocument(editor.element)).toBe('X abに');
    await end(editor);
    expect(editor.value()).toBe('X abに');
    expect(readLiveDocument(editor.element)).toBe('X abに');
    // A new composition after it is read back normally.
    await start(editor);
    await composeInto(editor, 'X abにほ');
    await end(editor);
    expect(editor.value()).toBe('X abにほ');
  });

  test('ending a composition for a send reads the word being composed, and only once', async () => {
    const editor = await probe('see ');
    // Nothing is being composed: nothing to end, and the host need not wait.
    expect(editor.field().endComposition()).toBe(false);
    await focusAt(editor, 4);
    await start(editor);
    await composeInto(editor, 'see yo');
    // Everything composed has been reported: ended, and nothing changed.
    expect(editor.field().endComposition()).toBe(false);
    expect(editor.composition).toEqual(['start', 'end:see yo']);
    // The platform's own end afterwards is not read again.
    must(editor.element.firstElementChild, 'the line').textContent = 'see you later';
    await end(editor);
    expect(editor.value()).toBe('see yo');
    expect(readLiveDocument(editor.element)).toBe('see yo');

    // A word the keyboard changed without reporting it yet goes with the send, and the host is told to wait.
    await start(editor);
    must(editor.element.firstElementChild, 'the line').textContent = 'see you';
    let changed = false;
    await interact(() => {
      changed = editor.field().endComposition();
    });
    expect(changed).toBe(true);
    expect(editor.value()).toBe('see you');
  });

  test('ending a composition once the editor is gone is nothing', async () => {
    const editor = await probe('a');
    const field = editor.field();
    await editor.view.unmount();
    expect(field.endComposition()).toBe(false);
  });
});
