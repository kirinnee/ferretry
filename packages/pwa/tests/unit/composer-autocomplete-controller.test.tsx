import { afterEach, describe, expect, test } from 'bun:test';
import { type ReactElement, useRef, useState } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import {
  type ComposerAutocompleteProvider,
  useComposerAutocomplete,
} from '../../src/components/composer-autocomplete.ts';
import { interact, mount, must } from '../support/dom.ts';
import { render as renderTree, run, runAsync } from '../support/react.ts';

const renderers: ReactTestRenderer[] = [];

const render = (element: ReactElement): ReactTestRenderer => {
  const renderer = renderTree(element);
  renderers.push(renderer);
  return renderer;
};

afterEach(() => {
  run(() => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
});

const providers: readonly ComposerAutocompleteProvider[] = [
  {
    id: 'commands:daemon-a:session-a',
    trigger: '/',
    label: 'Commands',
    candidates: () => ({
      candidates: [
        { id: 'compact', kind: 'command', label: 'compact', replacement: '/compact' },
        { id: 'blocked', kind: 'command', label: 'blocked', replacement: '/blocked', disabled: true },
      ],
      contextLabel: 'Daemon commands',
    }),
  },
];

function Probe({
  initial = '/',
  sourceProviders = providers,
  input,
  acceptChanges = true,
  compositionCaret = true,
}: {
  readonly initial?: string;
  readonly sourceProviders?: readonly ComposerAutocompleteProvider[];
  readonly input?: { value: string; setSelectionRange(start: number, end: number): void };
  readonly acceptChanges?: boolean;
  /** A host that reports no caret when the composition ends still has to work. */
  readonly compositionCaret?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef(input as HTMLTextAreaElement | null);
  const controller = useComposerAutocomplete({
    value,
    onValueChange: next => {
      if (!acceptChanges) {
        if (input) input.value = '/rewritten';
        setValue('/rewritten');
        return;
      }
      if (input) input.value = next;
      setValue(next);
    },
    inputRef,
    providers: sourceProviders,
    listboxId: 'composer-list',
  });
  return (
    <>
      <textarea
        {...controller.textareaAria}
        data-active={String(controller.activeIndex)}
        data-open={String(controller.open)}
        data-status={controller.status}
        data-value={value}
        onCompositionEnd={() =>
          compositionCaret
            ? controller.endComposition({ start: value.length, end: value.length })
            : controller.endComposition()
        }
        onCompositionStart={controller.startComposition}
        onKeyDown={controller.handleKeyDown}
        onSelect={() => controller.syncSelection({ start: value.length, end: value.length })}
      />
      <button onClick={() => controller.accept(99)} type="button">
        Impossible acceptance
      </button>
    </>
  );
}

/** A direct-sigil family: it answers instantly and has rows to steal Enter with. */
const agentProviders: readonly ComposerAutocompleteProvider[] = [
  {
    id: 'agents:daemon-a:session-a',
    trigger: ':',
    label: 'Agents',
    candidates: () => ({
      candidates: [{ id: 'zelda', kind: 'agent', label: 'zelda', replacement: ':zelda' }],
      contextLabel: ': fleet agents',
    }),
  },
];

const key = (value: string) => ({ key: value, nativeEvent: { isComposing: false }, preventDefault() {} });

describe('useComposerAutocomplete', () => {
  test('dismisses an open list only after a document click outside the textarea', async () => {
    const mounted = await mount(<Probe />);
    const textarea = must(mounted.container.querySelector('textarea'), 'composer textarea');
    expect(textarea.getAttribute('aria-expanded')).toBe('true');
    await interact(() => document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(textarea.getAttribute('aria-expanded')).toBeNull();
    await mounted.unmount();
  });

  test('renders a real controller state, navigates enabled candidates, accepts, and dismisses', () => {
    const selected: Array<readonly [number, number]> = [];
    const input = { value: '/', setSelectionRange: (start: number, end: number) => selected.push([start, end]) };
    const renderer = render(<Probe input={input} />);
    const textarea = () => renderer.root.findByType('textarea');

    expect(textarea().props['aria-autocomplete']).toBe('list');
    expect(textarea().props['aria-controls']).toBe('composer-list');
    expect(textarea().props['aria-expanded']).toBe(true);
    expect(textarea().props['aria-activedescendant']).toBe('composer-list-option-0');
    expect(textarea().props['data-status']).toBe('ready');
    expect(textarea().props['data-active']).toBe('0');

    run(() => textarea().props.onKeyDown(key('ArrowUp')));
    expect(textarea().props['data-active']).toBe('0');
    run(() => textarea().props.onKeyDown(key('Escape')));
    expect(textarea().props['data-open']).toBe('false');
    run(() => textarea().props.onKeyDown(key('x')));
    run(() => renderer.root.findByType('button').props.onClick());

    const accepted = render(<Probe input={input} />);
    const acceptedTextarea = () => accepted.root.findByType('textarea');
    let acceptedByTab = false;
    run(() => {
      acceptedByTab = acceptedTextarea().props.onKeyDown(key('Tab'));
    });
    expect(acceptedByTab).toBe(true);
    expect(acceptedTextarea().props['data-value']).toBe('/compact ');
    expect(acceptedTextarea().props['data-open']).toBe('false');
    expect(selected).toEqual([[9, 9]]);

    const rejected = render(<Probe acceptChanges={false} input={{ value: '/', setSelectionRange() {} }} />);
    run(() => rejected.root.findByType('textarea').props.onKeyDown(key('Enter')));
    expect(rejected.root.findByType('textarea').props['data-value']).toBe('/rewritten');
  });

  test('uses the initial subset and reports asynchronous or thrown provider failures', async () => {
    const initial: ComposerAutocompleteProvider = {
      id: 'initial:daemon-a:session-a',
      trigger: '/',
      label: 'Initial',
      initialCandidates: () => ({ candidates: [{ id: 'now', kind: 'command', label: 'now', replacement: '/now' }] }),
      candidates: () => new Promise(() => undefined),
    };
    const initialRenderer = render(<Probe sourceProviders={[initial]} />);
    expect(initialRenderer.root.findByType('textarea').props['data-status']).toBe('ready');

    let reject: (error: Error) => void = () => undefined;
    const failing: ComposerAutocompleteProvider = {
      id: 'failing:daemon-a:session-a',
      trigger: '/',
      label: 'Failing',
      candidates: () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    };
    const failedRenderer = render(<Probe sourceProviders={[failing]} />);
    expect(failedRenderer.root.findByType('textarea').props['data-status']).toBe('loading');
    await runAsync(async () => {
      reject(new Error('offline'));
      await Promise.resolve();
    });
    expect(failedRenderer.root.findByType('textarea').props['data-status']).toBe('error');

    const thrown: ComposerAutocompleteProvider = {
      id: 'thrown:daemon-a:session-a',
      trigger: '/',
      label: 'Thrown',
      candidates: () => {
        throw new Error('unavailable');
      },
    };
    expect(render(<Probe sourceProviders={[thrown]} />).root.findByType('textarea').props['data-status']).toBe('error');
  });

  test('opens a direct-sigil list with no row selected, so Enter still belongs to the reader', () => {
    const input = { value: ':zel', setSelectionRange: () => undefined };
    const renderer = render(<Probe initial=":zel" input={input} sourceProviders={agentProviders} />);
    const textarea = () => renderer.root.findByType('textarea');

    // The list is open and ready, and yet nothing is active: this pair is the
    // whole protection. `composer.tsx` forwards Enter only while a row is
    // selected, so a message containing `A & B` sends instead of completing.
    expect(textarea().props['data-open']).toBe('true');
    expect(textarea().props['data-status']).toBe('ready');
    expect(textarea().props['data-active']).toBe('-1');
    expect(textarea().props['aria-activedescendant']).toBeUndefined();

    let consumed = true;
    run(() => {
      consumed = textarea().props.onKeyDown(key('Enter'));
    });
    expect(consumed).toBe(false);
    expect(textarea().props['data-value']).toBe(':zel');

    // ArrowDown is the opt-in, and from there the row accepts as usual.
    run(() => textarea().props.onKeyDown(key('ArrowDown')));
    expect(textarea().props['data-active']).toBe('0');
    run(() => textarea().props.onKeyDown(key('Enter')));
    expect(textarea().props['data-value']).toBe(':zelda ');
  });

  test('accepts a direct-sigil row from a pointer without any keyboard opt-in', () => {
    const renderer = render(<Probe initial=":zel" sourceProviders={agentProviders} />);
    run(() => renderer.root.findByType('button').props.onClick());
    // Index 99 does not exist, so nothing was inserted — but `accept` is the
    // pointer's path and it never consults the active row.
    expect(renderer.root.findByType('textarea').props['data-value']).toBe(':zel');
  });

  test('keeps every list shut while an IME composition owns the bytes, and re-detects when it ends', async () => {
    const mounted = await mount(<Probe initial=":zel" sourceProviders={agentProviders} />);
    const textarea = must(mounted.container.querySelector('textarea'), 'composer textarea');
    expect(textarea.dataset.open).toBe('true');

    await interact(() => textarea.dispatchEvent(new Event('compositionstart', { bubbles: true })));
    expect(textarea.dataset.open).toBe('false');
    // A keystroke during composition is the IME's, not the list's.
    expect(textarea.dataset.active).toBe('-1');

    await interact(() => textarea.dispatchEvent(new Event('compositionend', { bubbles: true })));
    expect(textarea.dataset.open).toBe('true');
    await mounted.unmount();
  });

  test('ends a composition that reports no caret without losing the one it had', () => {
    const renderer = render(<Probe compositionCaret={false} initial=":zel" sourceProviders={agentProviders} />);
    const textarea = () => renderer.root.findByType('textarea');
    run(() => textarea().props.onCompositionStart());
    expect(textarea().props['data-open']).toBe('false');
    run(() => textarea().props.onCompositionEnd());
    expect(textarea().props['data-open']).toBe('true');
  });

  test('lets a provider refuse to open at all, without disabling the composer', () => {
    const suppressed: ComposerAutocompleteProvider[] = [
      { ...(agentProviders[0] as ComposerAutocompleteProvider), shouldOpen: () => false },
    ];
    const renderer = render(<Probe initial=":zel" sourceProviders={suppressed} />);
    expect(renderer.root.findByType('textarea').props['data-open']).toBe('false');
    expect(renderer.root.findByType('textarea').props['data-status']).toBe('idle');
  });

  test('does not restart a provider request for a content-identical caret update', () => {
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const provider: ComposerAutocompleteProvider = {
      id: 'stable:daemon-a:session-a',
      trigger: '/',
      label: 'Stable',
      initialCandidates: () => ({
        candidates: [{ id: 'compact', kind: 'command', label: 'compact', replacement: '/compact' }],
      }),
      candidates: context => {
        calls += 1;
        firstSignal ??= context.signal;
        return new Promise(() => undefined);
      },
    };
    const renderer = render(<Probe initial="/comp" sourceProviders={[provider]} />);

    expect(calls).toBe(1);
    expect(firstSignal?.aborted).toBe(false);
    run(() => renderer.root.findByType('textarea').props.onSelect());

    expect(calls).toBe(1);
    expect(firstSignal?.aborted).toBe(false);
  });
});
