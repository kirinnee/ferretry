/**
 * Copying is the whole point of a command block, so a refused copy has to be
 * visible rather than silent — and the promise behind it has to be consumed,
 * because an unhandled rejection fails this suite for real.
 */

import { describe, expect, it } from 'bun:test';

import { browserClipboardWriter, CopyButton } from '../../../src/features/onboarding/copy-button.tsx';
import { interact, mount, must } from '../../support/dom.ts';

const click = async (target: Element): Promise<void> => {
  await interact(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

const patchGlobal = (host: object, name: string, value: unknown): (() => void) => {
  const original = Object.getOwnPropertyDescriptor(host, name);
  Object.defineProperty(host, name, { configurable: true, writable: true, value });
  return () => {
    if (original === undefined) delete (host as Record<string, unknown>)[name];
    else Object.defineProperty(host, name, original);
  };
};

describe('CopyButton', () => {
  it('reports a successful copy in a live region that was already there', async () => {
    const copied: string[] = [];
    const view = await mount(
      <CopyButton
        text="fy daemon status"
        label="Copy status command"
        write={async text => {
          copied.push(text);
        }}
      />,
    );
    const status = must(view.container.querySelector('[role="status"]'), 'the copy status');
    // Present from first paint and empty: a region that appears with its own
    // text announces nothing.
    expect(status.textContent).toBe('');

    await click(must(view.container.querySelector('button'), 'the copy button'));

    expect(copied).toEqual(['fy daemon status']);
    expect(status.textContent).toBe('Copied');
    expect(status.getAttribute('data-onboarding-copy-status')).toBe('copied');
    await view.unmount();
  });

  it('says so when the browser refuses, instead of pretending', async () => {
    const view = await mount(
      <CopyButton text="fy pair" label="Copy pair command" write={async () => Promise.reject(new Error('denied'))} />,
    );

    await click(must(view.container.querySelector('button'), 'the copy button'));

    const status = must(view.container.querySelector('[role="status"]'), 'the copy status');
    expect(status.textContent).toContain('select the text');
    expect(status.getAttribute('data-onboarding-copy-status')).toBe('failed');
    await view.unmount();
  });

  it('is small, quiet and icon-led, and still carries its whole name', async () => {
    const view = await mount(<CopyButton text="fy --version" label="Copy check" write={async () => {}} />);
    const button = must(view.container.querySelector('button'), 'the copy button');

    // Deliberately under the control floor: a repeated shortcut, never the way
    // to make progress. The one control that gates progress keeps the floor.
    expect(button.className).toContain('h-8');
    expect(button.className).not.toContain('44px');
    expect(button.className).toContain('border-transparent');
    // Icon-led means the name has to come from somewhere.
    expect(button.textContent).toBe('');
    expect(button.getAttribute('aria-label')).toBe('Copy check');
    await view.unmount();
  });

  it('answers with a shape as well as a colour, so a tick is not the only signal', async () => {
    const view = await mount(<CopyButton text="fy pair" label="Copy pair command" write={async () => {}} />);
    const button = must(view.container.querySelector('button'), 'the copy button');
    const iconName = (): string | null => button.querySelector('svg')?.getAttribute('class') ?? null;
    const resting = iconName();

    await click(button);

    expect(iconName()).not.toBe(resting);
    expect(button.className).toContain('text-ok');
    await view.unmount();
  });
});

describe('browserClipboardWriter', () => {
  it('writes through the real clipboard when the browser has one', async () => {
    const written: string[] = [];
    const restore = patchGlobal(globalThis, 'navigator', {
      clipboard: {
        writeText: async (value: string) => {
          written.push(value);
        },
      },
    });
    try {
      await browserClipboardWriter()('fy pair');
      expect(written).toEqual(['fy pair']);
    } finally {
      restore();
    }
  });

  it('rejects rather than silently doing nothing where there is no clipboard', async () => {
    const restore = patchGlobal(globalThis, 'navigator', {});
    try {
      await expect(browserClipboardWriter()('fy pair')).rejects.toThrow('clipboard access');
    } finally {
      restore();
    }
  });
});
