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
