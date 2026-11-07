import { afterEach, describe, expect, it } from 'bun:test';
import { CheckCheck } from 'lucide-react';
import { useState } from 'react';
import { ActionsMenu } from '../../../../src/features/session-actions/actions-menu.tsx';
import type { SessionActionSection } from '../../../../src/features/session-actions/registry.ts';
import { interact, type Mounted, mount, must, pressKey } from '../../../support/dom.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const sections: SessionActionSection[] = [
  {
    group: 'session',
    label: 'Session',
    entries: [
      {
        kind: 'form',
        id: 'resolved',
        label: '3 resolved',
        title: 'Resolved Attention',
        heading: 'Resolved · 3',
        presentation: 'drawer',
        icon: CheckCheck,
        render: host => (
          <ul data-the-list="">
            <li>one</li>
            <li>{`compact: ${host.compact}`}</li>
          </ul>
        ),
      },
    ],
  },
];

const open = async (compact: boolean): Promise<HTMLElement> => {
  function Host() {
    const [form, setForm] = useState<string | null>(null);
    return <ActionsMenu compact={compact} form={form} name="Hadi" onFormChange={setForm} sections={sections} />;
  }
  mounted = await mount(<Host />);
  const root = mounted.container;
  await interact(() => must(root.querySelector<HTMLElement>('[data-session-actions-trigger]'), 'trigger').click());
  await interact(() =>
    must(root.querySelector<HTMLElement>('[data-session-action-item="resolved"]'), 'the resolved row').click(),
  );
  return root;
};

const drawer = (root: HTMLElement): HTMLElement | null => root.querySelector('[data-session-action-drawer]');

describe('a list opened from Actions as a drawer', () => {
  it('is a modal dialog with a "Resolved · N" header and a close button, not a headerless popover', async () => {
    const root = await open(false);
    expect(root.querySelector('[data-session-action-popover]')).toBeNull();
    const dialog = must(root.querySelector('[role="dialog"]'), 'dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe(must(dialog.querySelector('h2'), 'heading').id);
    expect(must(dialog.querySelector('h2'), 'heading').textContent).toBe('Resolved · 3');
    expect(dialog.querySelector('button[aria-label="Close Resolved Attention"]')).not.toBeNull();
    expect(drawer(root)?.hasAttribute('data-compact')).toBe(false);
    expect(
      must(drawer(root), 'drawer').querySelector('[data-session-action-drawer-body] [data-the-list]'),
    ).not.toBeNull();
  });

  it('keeps the list in the drawer’s one scroll body, under the header', async () => {
    const root = await open(false);
    const dialog = must(root.querySelector('[role="dialog"]'), 'dialog');
    const body = must(dialog.querySelector('[data-session-action-drawer-body]'), 'body');
    expect(body.contains(dialog.querySelector('[data-the-list]'))).toBe(true);
    expect(body.contains(dialog.querySelector('header'))).toBe(false);
  });

  it('closes on the ✕, and gives focus back to the Actions button', async () => {
    const root = await open(false);
    await interact(() => must(root.querySelector<HTMLElement>('[data-session-action-drawer-close]'), 'close').click());
    expect(drawer(root)).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('[data-session-actions-trigger]'));
  });

  it('closes on Escape, and gives focus back to the Actions button', async () => {
    const root = await open(false);
    await interact(() => pressKey(document, 'Escape'));
    expect(drawer(root)).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('[data-session-actions-trigger]'));
  });

  it('closes on a click on the backdrop', async () => {
    const root = await open(false);
    await interact(() =>
      must(root.querySelector<HTMLElement>('[data-session-action-drawer-backdrop]'), 'backdrop').click(),
    );
    expect(drawer(root)).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('[data-session-actions-trigger]'));
  });

  it('traps Tab inside: from the last control it wraps to the first, never out to the page', async () => {
    const root = await open(false);
    const close = must(root.querySelector<HTMLElement>('[data-session-action-drawer-close]'), 'close');
    close.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await interact(() => close.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
  });

  it('is the whole screen on a phone, told the host is compact', async () => {
    const root = await open(true);
    expect(drawer(root)?.hasAttribute('data-compact')).toBe(true);
    expect(root.querySelector('[data-bottom-sheet]')).toBeNull();
    expect(root.textContent).toContain('compact: true');
    expect(root.querySelector('button[aria-label="Close Resolved Attention"]')).not.toBeNull();
  });
});
