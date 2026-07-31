import { describe, expect, it } from 'bun:test';
import { createRef } from 'react';
import { SIDE_PANE_SEARCH_DEBOUNCE_MS, SidePaneSearch } from '../../src/shell/side-pane-search.tsx';
import { interact, mount, pressKey } from '../support/dom.ts';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Short enough to keep the suite quick, long enough to observe coalescing. */
const DEBOUNCE = 20;

/**
 * React tracks the last value it wrote on the DOM node itself, so assigning
 * `input.value` directly is invisible to it. Writing through the prototype
 * setter is what a real keystroke does and is what makes onChange fire.
 */
const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

const type = async (input: HTMLInputElement, text: string): Promise<void> => {
  await interact(() => {
    nativeValueSetter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const inputOf = (container: HTMLElement): HTMLInputElement => container.querySelector('input') as HTMLInputElement;
const clearButtonOf = (container: HTMLElement): HTMLButtonElement | null => container.querySelector('button');

describe('SidePaneSearch', () => {
  it('labels the field, keeps browser autofill out of it, and mints a collision-free id', async () => {
    const first = await mount(
      <SidePaneSearch value="" onChange={() => {}} ariaLabel="Filter sessions" placeholder="Search sessions" />,
    );
    const second = await mount(
      <SidePaneSearch value="" onChange={() => {}} ariaLabel="Filter tasks" placeholder="Search tasks" />,
    );
    const input = inputOf(first.container);

    expect(input.getAttribute('aria-label')).toBe('Filter sessions');
    expect(input.getAttribute('placeholder')).toBe('Search sessions');
    expect(input.getAttribute('type')).toBe('text');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.id).toStartWith('side-pane-search-');
    expect(input.id).not.toContain(':');
    expect(inputOf(second.container).id).not.toBe(input.id);
    expect(first.container.querySelector('[data-side-pane-search]')?.getAttribute('data-debounce-ms')).toBe(
      String(SIDE_PANE_SEARCH_DEBOUNCE_MS),
    );

    await first.unmount();
    await second.unmount();
  });

  it('accepts a caller-supplied id so a label elsewhere can point at the field', async () => {
    const mounted = await mount(
      <SidePaneSearch value="" onChange={() => {}} ariaLabel="Filter" placeholder="Search" id="files-search" />,
    );

    expect(inputOf(mounted.container).id).toBe('files-search');

    await mounted.unmount();
  });

  it('keeps typing local and reports one debounced value, not one per keystroke', async () => {
    const seen: string[] = [];
    const mounted = await mount(
      <SidePaneSearch
        value=""
        onChange={value => seen.push(value)}
        ariaLabel="Filter"
        placeholder="Search"
        debounceMs={DEBOUNCE}
      />,
    );
    const input = inputOf(mounted.container);

    await type(input, 'a');
    await type(input, 'ab');
    await type(input, 'abc');

    expect(seen).toEqual([]);
    expect(input.value).toBe('abc');

    await interact(() => sleep(DEBOUNCE * 3));

    expect(seen).toEqual(['abc']);

    // The committed value is already on screen, so it must not bounce again.
    await mounted.render(
      <SidePaneSearch
        value="abc"
        onChange={value => seen.push(value)}
        ariaLabel="Filter"
        placeholder="Search"
        debounceMs={DEBOUNCE}
      />,
    );
    await interact(() => sleep(DEBOUNCE * 3));

    expect(seen).toEqual(['abc']);

    await mounted.unmount();
  });

  it('lets an external reset win even over a field the reader is still holding', async () => {
    const seen: string[] = [];
    const view = (value: string) => (
      <SidePaneSearch
        value={value}
        onChange={next => seen.push(next)}
        ariaLabel="Filter"
        placeholder="Search"
        debounceMs={DEBOUNCE}
      />
    );
    const mounted = await mount(view('abc'));
    const input = inputOf(mounted.container);

    await type(input, 'abcd');
    // A session switch resets the query while the draft is still pending.
    await mounted.render(view(''));

    expect(input.value).toBe('');

    await interact(() => sleep(DEBOUNCE * 3));

    expect(seen).toEqual([]);

    await mounted.unmount();
  });

  it('flushes on blur, so a pane is never left filtered by an abandoned draft', async () => {
    const seen: string[] = [];
    const blurs: string[] = [];
    const mounted = await mount(
      <SidePaneSearch
        value=""
        onChange={value => seen.push(value)}
        onBlur={() => blurs.push('blur')}
        ariaLabel="Filter"
        placeholder="Search"
        debounceMs={10_000}
      />,
    );
    const input = inputOf(mounted.container);

    await type(input, 'urgent');
    await interact(() => input.dispatchEvent(new Event('focusout', { bubbles: true })));

    expect(seen).toEqual(['urgent']);
    expect(blurs).toEqual(['blur']);

    // A second blur with nothing pending must not re-submit.
    await interact(() => input.dispatchEvent(new Event('focusout', { bubbles: true })));

    expect(seen).toEqual(['urgent']);

    await mounted.unmount();
  });

  it('clears immediately and returns focus to the field it cleared', async () => {
    const seen: string[] = [];
    const inputRef = createRef<HTMLInputElement>();
    const mounted = await mount(
      <SidePaneSearch
        value=""
        onChange={value => seen.push(value)}
        ariaLabel="Filter"
        placeholder="Search"
        debounceMs={10_000}
        inputRef={inputRef}
        clearLabel="Clear the filter"
      />,
    );
    const input = inputOf(mounted.container);

    expect(clearButtonOf(mounted.container)).toBeNull();

    await type(input, 'urgent');
    const clear = clearButtonOf(mounted.container) as HTMLButtonElement;

    expect(clear.getAttribute('aria-label')).toBe('Clear the filter');

    // The press must not blur the field before the click lands.
    const mouseDown = new Event('mousedown', { bubbles: true, cancelable: true });
    await interact(() => clear.dispatchEvent(mouseDown));

    expect(mouseDown.defaultPrevented).toBe(true);

    await interact(() => clear.dispatchEvent(new Event('click', { bubbles: true })));

    expect(seen).toEqual(['']);
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect(clearButtonOf(mounted.container)).toBeNull();

    await mounted.unmount();
  });

  it('clears without an input ref, when the caller does not want focus moved', async () => {
    const seen: string[] = [];
    const mounted = await mount(
      <SidePaneSearch
        value=""
        onChange={value => seen.push(value)}
        ariaLabel="Filter"
        placeholder="Search"
        debounceMs={10_000}
      />,
    );

    await type(inputOf(mounted.container), 'urgent');
    await interact(() =>
      (clearButtonOf(mounted.container) as HTMLButtonElement).dispatchEvent(new Event('click', { bubbles: true })),
    );

    expect(seen).toEqual(['']);

    await mounted.unmount();
  });

  it('goes quiet while disabled: no debounce, no clear action', async () => {
    const seen: string[] = [];
    const mounted = await mount(
      <SidePaneSearch
        value="urgent"
        onChange={value => seen.push(value)}
        ariaLabel="Filter"
        placeholder="Search"
        debounceMs={DEBOUNCE}
        disabled
      />,
    );
    const input = inputOf(mounted.container);

    expect(input.disabled).toBe(true);
    expect(clearButtonOf(mounted.container)).toBeNull();

    await type(input, 'urgently');
    await interact(() => sleep(DEBOUNCE * 3));

    expect(seen).toEqual([]);

    await mounted.unmount();
  });

  it('passes focus and key events through to the surface that owns the pane', async () => {
    const events: string[] = [];
    const mounted = await mount(
      <SidePaneSearch
        value=""
        onChange={() => {}}
        ariaLabel="Filter"
        placeholder="Search"
        onFocus={() => events.push('focus')}
        onKeyDown={event => events.push(`key:${event.key}`)}
      />,
    );
    const input = inputOf(mounted.container);

    await interact(() => {
      input.dispatchEvent(new Event('focusin', { bubbles: true }));
      pressKey(input, 'Escape');
    });

    expect(events).toEqual(['focus', 'key:Escape']);

    await mounted.unmount();
  });
});
