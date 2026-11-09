/**
 * S14 (m2) — the hand-off panel draws its QR with the shell's one encoder, and a link the encoder refuses (a first-run
 * page opened with a long query string builds one) is shown WITHOUT a code and with a sentence saying why, instead of
 * throwing into the view boundary and blanking the whole first run.
 */
import { describe, expect, it } from 'bun:test';
import { SetupHandoffPanel } from '../../../app/setup-handoff-panel.tsx';
import { tryQrModules } from '../../../app/setup-qr.ts';
import { interact, mount } from '../support/dom.ts';

const SHORT = 'https://f.invalid/setup#fy-setup=f1;route=add-client;step=scan';
// Far past the encoder's cap (version 20 at level M): a tracking link's worth of query string.
const LONG = `https://f.invalid/setup?utm=${'x'.repeat(1200)}#fy-setup=f1;route=add-client;step=scan`;
const PLAIN = 'https://f.invalid/setup';

const panel = (url: string, receiver: 'phone' | 'computer', share?: (payload: unknown) => Promise<void>) => (
  <SetupHandoffPanel
    url={url}
    plainUrl={PLAIN}
    receiver={receiver}
    write={async () => undefined}
    share={share as never}
    label="Link carrying this setup"
  />
);

describe('S14 tryQrModules', () => {
  it('answers the grid for a link that fits and undefined for one the encoder refuses', () => {
    expect(tryQrModules(SHORT)?.length).toBeGreaterThan(20);
    expect(tryQrModules(LONG)).toBeUndefined();
    expect(tryQrModules('')).toBeUndefined();
  });

  it('only the encoder’s own refusal is swallowed: any other failure is a bug and still throws', () => {
    expect(() => tryQrModules(undefined as unknown as string)).toThrow();
  });
});

describe('S14 the hand-off panel', () => {
  it('draws the QR for a phone when the link fits', async () => {
    const view = await mount(panel(SHORT, 'phone'));
    expect(view.container.querySelector('[data-onboarding-qr]')).not.toBeNull();
    expect(view.container.querySelector('[data-onboarding-qr-unavailable]')).toBeNull();
    expect(view.container.textContent).toContain('Point your phone');
    await view.unmount();
  });

  it('m2 shows a link too long for a code without one, says why, and keeps the link to copy', async () => {
    const view = await mount(panel(LONG, 'phone'));
    expect(view.container.querySelector('[data-onboarding-qr]')).toBeNull();
    expect(view.container.querySelector('[data-onboarding-qr-unavailable]')?.textContent).toContain(
      'too long to draw as a code',
    );
    expect(view.container.textContent).not.toContain('Point your phone');
    // The link itself is still there to copy.
    expect(view.container.querySelector('[data-onboarding-handoff-url]')?.textContent).toBe(LONG);
    expect(view.container.querySelector('button[aria-label="Copy setup link"]')).not.toBeNull();
    await view.unmount();
  });

  it('a computer gets the link and no code, whatever its length', async () => {
    for (const url of [SHORT, LONG]) {
      const view = await mount(panel(url, 'computer'));
      expect(view.container.querySelector('[data-onboarding-qr]')).toBeNull();
      expect(view.container.querySelector('[data-onboarding-qr-unavailable]')).toBeNull();
      expect(view.container.textContent).toContain('no code to scan');
      await view.unmount();
    }
  });

  it('offers Share where the browser has a share sheet, and a declined share is not an error', async () => {
    const sent: unknown[] = [];
    const view = await mount(
      panel(SHORT, 'computer', async payload => {
        sent.push(payload);
        throw new DOMException('declined', 'AbortError');
      }),
    );
    await interact(() => {
      view.container.querySelector<HTMLElement>('[data-onboarding-share]')?.click();
    });
    expect(sent).toEqual([{ title: 'Ferretry setup', url: SHORT }]);
    await view.unmount();
  });
});
