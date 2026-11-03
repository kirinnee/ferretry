/**
 * The hand-off carries the place, never a secret, and the carrier is decided by
 * who RECEIVES it: a phone is shown a QR, a computer is given a link to copy.
 */

import { describe, expect, it } from 'bun:test';

import { SetupHandoffPanel } from '../../../src/features/onboarding/setup-handoff-panel.tsx';
import { interact, mount, must } from '../../support/dom.ts';

const URL_WITH_PLACE = 'https://ferretry.example.invalid/setup#fy-setup=v2;route=first-time;step=handoff';
const PLAIN = 'https://ferretry.example.invalid/setup';

const click = async (target: Element): Promise<void> => {
  await interact(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

describe('the setup hand-off panel', () => {
  it('draws a local QR for a phone, labelled, with the public link beside it', async () => {
    const view = await mount(
      <SetupHandoffPanel
        url={URL_WITH_PLACE}
        plainUrl={PLAIN}
        receiver="phone"
        write={async () => {}}
        label="Setup link for your phone"
      />,
    );

    const qr = must(view.container.querySelector('[data-onboarding-qr]'), 'the QR');
    expect(qr.tagName.toLowerCase()).toBe('svg');
    expect(qr.getAttribute('role')).toBe('img');
    expect(qr.getAttribute('aria-label')).toBe('Setup link for your phone');
    expect(qr.querySelectorAll('rect').length).toBeGreaterThan(10);
    // Generated here: nothing is fetched and no image is referenced.
    expect(view.container.querySelector('img')).toBeNull();
    expect(qr.outerHTML).not.toMatch(/https?:|href|<image|<foreignObject/);
    expect(qr.outerHTML).not.toContain('data:image');
    // The accessible name never contains the link: a QR is not read out.
    expect(qr.getAttribute('aria-label')).not.toContain('fy-setup');

    expect(must(view.container.querySelector('[data-onboarding-handoff-url]'), 'the link').textContent).toBe(
      URL_WITH_PLACE,
    );
    // The phone's copy is the quiet icon; there is no primary action.
    expect(view.container.querySelector('[data-variant="primary"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Copy setup link"]')).not.toBeNull();
    await view.unmount();
  });

  it('gives a computer a primary Copy setup link and no QR', async () => {
    const copied: string[] = [];
    const view = await mount(
      <SetupHandoffPanel
        url={URL_WITH_PLACE}
        plainUrl={PLAIN}
        receiver="computer"
        write={async text => {
          copied.push(text);
        }}
        label="Setup link"
      />,
    );

    expect(view.container.querySelector('[data-onboarding-qr]')).toBeNull();
    const copy = must(view.container.querySelector('[data-onboarding-copy="Copy setup link"]'), 'the primary copy');
    expect(copy.getAttribute('data-variant')).toBe('primary');
    await click(copy);
    expect(copied).toEqual([URL_WITH_PLACE]);
    expect(copy.textContent).toBe('Copied');
    await view.unmount();
  });

  it('offers the share sheet only when the browser has one, and swallows a declined share', async () => {
    const without = await mount(
      <SetupHandoffPanel url={URL_WITH_PLACE} plainUrl={PLAIN} receiver="computer" write={async () => {}} label="x" />,
    );
    expect(without.container.querySelector('[data-onboarding-share]')).toBeNull();
    await without.unmount();

    const shared: unknown[] = [];
    const withShare = await mount(
      <SetupHandoffPanel
        url={URL_WITH_PLACE}
        plainUrl={PLAIN}
        receiver="computer"
        write={async () => {}}
        label="x"
        share={async payload => {
          shared.push(payload);
          throw new Error('AbortError');
        }}
      />,
    );
    await click(must(withShare.container.querySelector('[data-onboarding-share]'), 'the share control'));
    expect(shared).toEqual([{ title: 'Ferretry setup', url: URL_WITH_PLACE }]);
    await withShare.unmount();
  });

  it('offers the short page beside the full link', async () => {
    const view = await mount(
      <SetupHandoffPanel url={URL_WITH_PLACE} plainUrl={PLAIN} receiver="computer" write={async () => {}} label="x" />,
    );
    expect(view.container.textContent).toContain(`Rather type it? ${PLAIN}`);
    await view.unmount();
  });
});
