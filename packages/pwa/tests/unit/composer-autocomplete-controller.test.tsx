import { describe, expect, test } from 'bun:test';
import { useRef, useState } from 'react';
import {
  type ComposerAutocompleteProvider,
  useComposerAutocomplete,
} from '../../src/components/composer-autocomplete.ts';
import { render, run, runAsync } from '../support/react.ts';
import { interact, mount, must } from '../support/dom.ts';

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
}: {
  readonly initial?: string;
  readonly sourceProviders?: readonly ComposerAutocompleteProvider[];
  readonly input?: { value: string; setSelectionRange(start: number, end: number): void };
  readonly acceptChanges?: boolean;
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
        onKeyDown={controller.handleKeyDown}
      />
      <button onClick={() => controller.accept(99)} type="button">
        Impossible acceptance
      </button>
    </>
  );
}

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
    run(() => acceptedTextarea().props.onKeyDown(key('Enter')));
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
});
