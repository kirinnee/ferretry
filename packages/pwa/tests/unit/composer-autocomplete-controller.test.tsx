import { describe, expect, test } from 'bun:test';
import { useRef, useState } from 'react';
import {
  type ComposerAutocompleteProvider,
  useComposerAutocomplete,
} from '../../src/components/composer-autocomplete.ts';
import { render, run } from '../support/react.ts';

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

function Probe() {
  const [value, setValue] = useState('/');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const controller = useComposerAutocomplete({
    value,
    onValueChange: setValue,
    inputRef,
    providers,
    listboxId: 'composer-list',
  });
  return (
    <textarea
      {...controller.textareaAria}
      data-active={String(controller.activeIndex)}
      data-open={String(controller.open)}
      data-status={controller.status}
      data-value={value}
      onKeyDown={controller.handleKeyDown}
      ref={inputRef}
    />
  );
}

const key = (value: string) => ({ key: value, nativeEvent: { isComposing: false }, preventDefault() {} });

describe('useComposerAutocomplete', () => {
  test('renders a real controller state, navigates enabled candidates, accepts, and dismisses', () => {
    const renderer = render(<Probe />);
    const textarea = () => renderer.root.findByType('textarea');

    expect(textarea().props['aria-autocomplete']).toBe('list');
    expect(textarea().props['aria-controls']).toBe('composer-list');
    expect(textarea().props['aria-expanded']).toBe(true);
    expect(textarea().props['aria-activedescendant']).toBe('composer-list-option-0');
    expect(textarea().props['data-status']).toBe('ready');
    expect(textarea().props['data-active']).toBe('0');

    run(() => textarea().props.onKeyDown(key('ArrowUp')));
    expect(textarea().props['data-active']).toBe('0');
    run(() => textarea().props.onKeyDown(key('Enter')));
    expect(textarea().props['data-value']).toBe('/compact ');
    expect(textarea().props['data-open']).toBe('false');

    run(() => textarea().props.onKeyDown(key('Escape')));
    expect(textarea().props['aria-expanded']).toBeUndefined();
  });
});
