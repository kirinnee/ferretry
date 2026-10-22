import { describe, expect, it } from 'bun:test';
import { LedgerMessage, OPEN_RESEND_RISK_COPY } from '../../src/components/ledger-message.tsx';
import type { LedgerSendRecord } from '../../src/lib/send-ledger.ts';
import { interact, type Mounted, mount, must, pressKey } from '../support/dom.ts';

const record = (overrides: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 'send-1',
  acceptedAt: '2026-10-21T09:00:00.000Z',
  message: 'ship it',
  attachmentIds: [],
  fate: 'accepted',
  ...overrides,
});

const trigger = (view: Mounted): HTMLButtonElement =>
  must(view.container.querySelector<HTMLButtonElement>('[data-ledger-more]'), 'the actions button');

const menu = (view: Mounted): HTMLElement | null => view.container.querySelector<HTMLElement>('[role="menu"]');

const keys = (view: Mounted): string[] =>
  Array.from(view.container.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(item => item.dataset.menuKey ?? '');

const item = (view: Mounted, key: string): HTMLElement =>
  must(view.container.querySelector<HTMLElement>(`[data-menu-key="${key}"]`), `the ${key} action`);

const buttonLabelled = (view: Mounted, label: string): HTMLElement =>
  must(
    Array.from(view.container.querySelectorAll<HTMLElement>('button')).find(button => button.textContent === label),
    `the "${label}" button`,
  );

const noop = async (): Promise<boolean> => true;

describe('the message actions button', () => {
  it('is one small labelled button on the status line, closed until it is used', async () => {
    const view = await mount(<LedgerMessage onCancel={noop} onRetry={noop} record={record()} write={async () => {}} />);
    const button = trigger(view);
    expect(button.getAttribute('aria-label')).toBe('Message actions');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.closest('.fy-receipt-line')).not.toBeNull();
    expect(menu(view)).toBeNull();
    await view.unmount();
  });

  it('opens on a press, lands on the first action, moves with the arrows and closes on Escape with focus back', async () => {
    const view = await mount(<LedgerMessage onCancel={noop} onRetry={noop} record={record()} write={async () => {}} />);
    await interact(() => trigger(view).click());
    expect(trigger(view).getAttribute('aria-expanded')).toBe('true');
    expect(keys(view)).toEqual(['send-again', 'cancel', 'copy']);
    expect(document.activeElement).toBe(item(view, 'send-again'));

    await interact(() => pressKey(item(view, 'send-again'), 'ArrowDown'));
    expect(document.activeElement).toBe(item(view, 'cancel'));
    await interact(() => pressKey(item(view, 'cancel'), 'End'));
    expect(document.activeElement).toBe(item(view, 'copy'));
    await interact(() => pressKey(item(view, 'copy'), 'Home'));
    expect(document.activeElement).toBe(item(view, 'send-again'));

    await interact(() => pressKey(document.body, 'Escape'));
    expect(menu(view)).toBeNull();
    expect(trigger(view).getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger(view));
    await view.unmount();
  });

  it('hands focus back to the button after an action that leaves the row in place', async () => {
    const copied: string[] = [];
    const view = await mount(
      <LedgerMessage onCancel={noop} record={record()} write={async text => void copied.push(text)} />,
    );
    await interact(() => trigger(view).click());
    await interact(() => item(view, 'copy').click());
    expect(copied).toEqual(['ship it']);
    expect(menu(view)).toBeNull();
    expect(document.activeElement).toBe(trigger(view));
    await view.unmount();
  });
});

describe('Send again from the menu', () => {
  it('sends nothing by itself: it opens the warning, and only its own button sends, forced', async () => {
    const attempts: Array<[string, boolean]> = [];
    const view = await mount(
      <LedgerMessage
        onRetry={async (attempted, force) => {
          attempts.push([attempted.sendId, force]);
          return true;
        }}
        record={record()}
      />,
    );
    await interact(() => trigger(view).click());
    await interact(() => item(view, 'send-again').click());
    expect(attempts).toEqual([]);
    expect(view.container.textContent).toContain(OPEN_RESEND_RISK_COPY);
    // Focus lands on the safe choice, so a stray Enter keeps waiting.
    expect(document.activeElement).toBe(buttonLabelled(view, 'Keep waiting'));

    await interact(() => buttonLabelled(view, 'Send again anyway').click());
    expect(attempts).toEqual([['send-1', true]]);
    expect(view.container.querySelector('[data-ledger-retry-confirm]')).toBeNull();
    await view.unmount();
  });

  it('returns focus to the actions button when the warning is turned down', async () => {
    let sent = 0;
    const view = await mount(
      <LedgerMessage
        onRetry={async () => {
          sent += 1;
          return true;
        }}
        record={record({ fate: 'unaccounted', unaccountedReason: 'timeout' })}
      />,
    );
    await interact(() => trigger(view).click());
    await interact(() => item(view, 'send-again').click());
    expect(document.activeElement).toBe(buttonLabelled(view, 'Not now'));
    await interact(() => buttonLabelled(view, 'Not now').click());
    expect(view.container.querySelector('[data-ledger-retry-confirm]')).toBeNull();
    expect(document.activeElement).toBe(trigger(view));
    expect(sent).toBe(0);
    await view.unmount();
  });
});
