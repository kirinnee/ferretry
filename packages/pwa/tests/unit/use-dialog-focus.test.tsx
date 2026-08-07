import { describe, expect, it } from 'bun:test';
import { useRef } from 'react';
import {
  escapeLayerCount,
  isTopEscapeLayer,
  pushEscapeLayer,
  useDialogFocus,
} from '../../src/hooks/use-dialog-focus.ts';
import { interact, mount, pressKey } from '../support/dom.ts';

function Dialog({
  open,
  onClose,
  autoFocus = true,
  label = 'Dialog',
}: {
  open: boolean;
  onClose: () => void;
  autoFocus?: boolean;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { onKeyDown } = useDialogFocus(open, ref, onClose, { autoFocus });
  if (!open) return null;
  return (
    <div ref={ref} role="dialog" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
      <button type="button">first</button>
      <button type="button">second</button>
    </div>
  );
}

/**
 * A dialog shaped like the one that exposed the hole: a `<details>` fold and a
 * horizontally scrolling panel BEFORE the buttons in DOM order.
 *
 * That order is the point. The trap wraps from the last focusable element to the
 * first, so an element the selector misses is skipped in BOTH directions when it
 * precedes everything the selector finds — and the trap `preventDefault()`s the Tab
 * that would otherwise have reached it, inside a container claiming
 * `aria-modal="true"`. `fy-render`'s failure state is exactly this shape.
 */
function FoldDialog({ onClose = () => {} }: { onClose?: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { onKeyDown } = useDialogFocus(true, ref, onClose, { autoFocus: false });
  return (
    <div ref={ref} role="dialog" aria-label="Fold" tabIndex={-1} onKeyDown={onKeyDown}>
      <details>
        <summary>Why</summary>
        <p>the precise reason</p>
      </details>
      <button type="button">Source</button>
      <button type="button">Exit</button>
      {/* LAST on purpose. The trap only intervenes at the two ends of its list, so a
          candidate placed in the middle is never proved to be in the list at all: the
          native order would carry Tab past it either way. With the summary FIRST and
          the scrollport LAST, each wrap has to name the other one, and dropping either
          from the selector makes one of the two tests below fail. */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: mirrors the shipped scrollport */}
      <section aria-label="Authored source" tabIndex={0}>
        <pre>a very long line</pre>
      </section>
    </div>
  );
}

describe('escape layers', () => {
  it('gives the topmost layer ownership and releases idempotently', () => {
    const first = {};
    const second = {};
    const releaseFirst = pushEscapeLayer(first);
    const releaseSecond = pushEscapeLayer(second);

    expect(escapeLayerCount()).toBe(2);
    expect(isTopEscapeLayer(second)).toBe(true);
    expect(isTopEscapeLayer(first)).toBe(false);

    releaseSecond();
    releaseSecond();
    expect(escapeLayerCount()).toBe(1);
    expect(isTopEscapeLayer(first)).toBe(true);

    releaseFirst();
    expect(escapeLayerCount()).toBe(0);
    expect(isTopEscapeLayer(first)).toBe(false);
  });

  it('removes the most recent entry when a token somehow appears twice', () => {
    const token = {};
    const releaseFirst = pushEscapeLayer(token);
    const releaseSecond = pushEscapeLayer(token);

    releaseSecond();
    expect(escapeLayerCount()).toBe(1);

    releaseFirst();
    expect(escapeLayerCount()).toBe(0);
  });

  it('ignores a release for a token that already left the stack', () => {
    const token = {};
    const release = pushEscapeLayer(token);
    const other = pushEscapeLayer({});
    release();
    release();

    expect(escapeLayerCount()).toBe(1);
    other();
  });
});

describe('useDialogFocus', () => {
  it('closes on Escape only for the dialog opened last', async () => {
    const closed: string[] = [];
    const under = await mount(<Dialog open onClose={() => closed.push('under')} label="Under" />);
    const over = await mount(<Dialog open onClose={() => closed.push('over')} label="Over" />);

    await interact(() => pressKey(document, 'Escape'));

    expect(closed).toEqual(['over']);

    await over.unmount();
    await interact(() => pressKey(document, 'Escape'));
    expect(closed).toEqual(['over', 'under']);

    await under.unmount();
  });

  it('wraps forward onto a <summary>, which the selector used to skip entirely', async () => {
    // Arrange — `<summary>` is focusable natively and carries no `tabindex`, so it
    // matched none of the selector's arms. The trap then wrapped straight past the fold
    // and `preventDefault()`ed the Tab that would have reached it — inside a container
    // claiming `aria-modal="true"`.
    const dialog = await mount(<FoldDialog />);
    const summary = dialog.container.querySelector('summary') as HTMLElement;
    const region = dialog.container.querySelector('section[aria-label]') as HTMLElement;
    region.focus();

    // Act — Tab from the LAST focusable element, which is where a forward wrap happens.
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Tab' });
    await interact(() => region.dispatchEvent(event));

    // Assert — it lands on the summary. Without `summary` in the selector the wrap
    // would land on the Source button instead, so this discriminates.
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(summary);

    await dialog.unmount();
  });

  it('wraps backward onto an explicitly focusable scrollport, so a long line is reachable', async () => {
    // Arrange — the other half of the same hole. A scrollport carries no attribute or
    // tag name the selector could match, so it needs an explicit `tabIndex={0}` from
    // its own component; Chromium focuses such scrollers natively, which is exactly
    // why a browser test kept looking correct while the trap skipped them.
    const dialog = await mount(<FoldDialog />);
    const summary = dialog.container.querySelector('summary') as HTMLElement;
    const region = dialog.container.querySelector('section[aria-label]') as HTMLElement;
    summary.focus();

    // Act — Shift+Tab from the FIRST focusable element, which is where a backward wrap
    // happens.
    const back = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Tab', shiftKey: true });
    await interact(() => summary.dispatchEvent(back));

    // Assert — it lands on the scrollport, because the scrollport is LAST. Were it
    // missing from the list the wrap would land on the Exit button, so this
    // discriminates rather than merely reading the fixture's own attribute back.
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(region);

    await dialog.unmount();
  });

  it('ignores every key that is not Escape', async () => {
    const closed: string[] = [];
    const dialog = await mount(<Dialog open onClose={() => closed.push('closed')} />);

    await interact(() => pressKey(document, 'a'));

    expect(closed).toEqual([]);
    await dialog.unmount();
  });

  it('moves focus onto the container, not onto its first control', async () => {
    const dialog = await mount(<Dialog open onClose={() => {}} />);

    expect(document.activeElement).toBe(dialog.container.querySelector('[role="dialog"]'));

    await dialog.unmount();
  });

  it('leaves focus alone when the caller opts out of autofocus', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const dialog = await mount(<Dialog open onClose={() => {}} autoFocus={false} />);

    expect(document.activeElement).toBe(opener);

    await dialog.unmount();
    opener.remove();
  });

  it('restores focus to whatever opened it', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const dialog = await mount(<Dialog open onClose={() => {}} />);
    expect(document.activeElement).not.toBe(opener);

    await dialog.render(<Dialog open={false} onClose={() => {}} />);

    expect(document.activeElement).toBe(opener);
    await dialog.unmount();
    opener.remove();
  });

  it('does not restore focus to an opener that has left the document', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const dialog = await mount(<Dialog open onClose={() => {}} />);
    opener.remove();

    await dialog.render(<Dialog open={false} onClose={() => {}} />);

    expect(document.activeElement).not.toBe(opener);
    await dialog.unmount();
  });

  it('wraps Tab from the last control back to the first, and Shift+Tab the other way', async () => {
    const dialog = await mount(<Dialog open onClose={() => {}} />);
    const panel = dialog.container.querySelector<HTMLElement>('[role="dialog"]');
    const buttons = [...dialog.container.querySelectorAll('button')];
    const first = buttons[0] as HTMLElement;
    const last = buttons[1] as HTMLElement;

    await interact(() => {
      last.focus();
      pressKey(last, 'Tab');
    });
    expect(document.activeElement).toBe(first);

    await interact(() => {
      first.focus();
      pressKey(first, 'Tab', { shiftKey: true });
    });
    expect(document.activeElement).toBe(last);

    // From the container itself, Shift+Tab still lands on the last control.
    await interact(() => {
      panel?.focus();
      pressKey(panel as HTMLElement, 'Tab', { shiftKey: true });
    });
    expect(document.activeElement).toBe(last);

    await dialog.unmount();
  });

  it('leaves a Tab in the middle of the dialog to the browser', async () => {
    const dialog = await mount(<Dialog open onClose={() => {}} />);
    const first = dialog.container.querySelector('button') as HTMLElement;

    await interact(() => {
      first.focus();
      pressKey(first, 'Tab');
    });

    expect(document.activeElement).toBe(first);
    await dialog.unmount();
  });

  it('ignores keys other than Tab on the dialog element', async () => {
    const dialog = await mount(<Dialog open onClose={() => {}} />);
    const last = [...dialog.container.querySelectorAll('button')][1] as HTMLElement;

    await interact(() => {
      last.focus();
      pressKey(last, 'ArrowDown');
    });

    expect(document.activeElement).toBe(last);
    await dialog.unmount();
  });
});
