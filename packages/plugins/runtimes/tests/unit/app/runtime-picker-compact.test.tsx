/**
 * THE RUNTIME PICKER IS ONE COMPACT CONTROL, NOT TWO OPEN LISTS (ferret-page-send, items 2 and 4).
 *
 * It sits in the composer's row (`composer.tools`). It used to draw the model list AND the reasoning list, open, in
 * the row: a four-row column beside a one-line text box, taller than the window, with Send painted below the fold. And
 * because it asked the daemon for the model catalog on mount, a daemon whose runtime discovery is not connected made
 * every composer on every page show a red "Account-aware model choices are unavailable" box.
 *
 * Now the row holds one small chip. The lists live in a popover that opens on a tap, and the catalog is asked for only
 * then; a catalog that cannot be read says so once, quietly, inside the popover.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { createElement, type FunctionComponent } from 'react';
import { ferretSummary } from '@ferretry/core-ferrets/contract/testing';
import { createRuntimePicker } from '../../../app/views/runtime-picker.tsx';
import type { RuntimesClient } from '../../../app/lib/client.ts';

const CATALOG = {
  harness: 'claude-code',
  source: 'wrapper-inventory',
  choices: [
    { value: 'claude-opus-5', label: 'Opus 5', isDefault: true, reasoningEfforts: [] },
    { value: 'claude-sonnet-5', label: 'Sonnet 5', reasoningEfforts: [] },
  ],
};

interface Asked {
  readonly route: string;
}

/** A daemon that answers the ferret and (unless `discovery` is off) its model catalog; every route asked is recorded. */
const daemon = (discovery: boolean): { readonly client: RuntimesClient; readonly asked: Asked[] } => {
  const asked: Asked[] = [];
  const client = {
    call: async (route: string) => {
      asked.push({ route });
      if (route === 'GET /v1/ferrets/:ferretId')
        return ferretSummary({ id: 's-1', harness: 'claude-code', model: 'claude-sonnet-5', state: 'idle' });
      if (route === 'GET /v1/ferrets/:id/runtime-models') {
        if (discovery) return CATALOG;
        throw new Error('Runtime model discovery is not connected to Ferrets yet.');
      }
      return {};
    },
  } as unknown as RuntimesClient;
  return { client, asked };
};

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const draw = async (client: RuntimesClient): Promise<HTMLElement> => {
  const Picker = createRuntimePicker(client) as unknown as FunctionComponent<PanelProps>;
  mounted = await mount(createElement(Picker, { subject: 's-1' } as PanelProps));
  const root = mounted.container;
  await settleUntil(
    () => root.querySelector('[data-runtime-picker]') !== null,
    () => `the picker drew its chip; drew: ${root.textContent ?? ''}`,
    interact,
  );
  return root;
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

/** The popover is a portal: it lives in the document, not in the composer's row. */
const popover = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-runtime-popover]');

describe('the runtime picker in the composer row', () => {
  it('is one chip and nothing else at rest: no list, no catalog request, no error', async () => {
    const { client, asked } = daemon(false);
    const root = await draw(client);
    await settle();

    expect(root.querySelectorAll('[data-runtime-chip]')).toHaveLength(1);
    expect(root.querySelector('[role="menu"]')).toBeNull();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.textContent).not.toContain('unavailable');
    expect(popover()).toBeNull();
    expect(asked.map(call => call.route)).not.toContain('GET /v1/ferrets/:id/runtime-models');
  });

  it('names the model in force on the chip, short, and says what it opens', async () => {
    const root = await draw(daemon(true).client);
    const chip = must(root.querySelector<HTMLElement>('[data-runtime-chip]'), 'the chip');
    expect(chip.textContent).toContain('claude-sonnet-5');
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(chip.getAttribute('aria-label')).toContain('model and reasoning');
  });

  it('opens a popover with both lists on a tap, outside the row, and closes on Escape', async () => {
    const { client, asked } = daemon(true);
    const root = await draw(client);
    const chip = must(root.querySelector<HTMLElement>('[data-runtime-chip]'), 'the chip');
    await interact(() => chip.click());
    await settle();

    const open = must(popover(), 'the popover');
    expect(root.contains(open)).toBe(false);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(open.querySelectorAll('[role="menu"]').length).toBeGreaterThanOrEqual(2);
    expect(open.textContent).toContain('Opus 5');
    expect(asked.map(call => call.route)).toContain('GET /v1/ferrets/:id/runtime-models');

    await interact(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      open.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(popover()).toBeNull();
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on a tap outside the popover', async () => {
    const root = await draw(daemon(true).client);
    await interact(() => must(root.querySelector<HTMLElement>('[data-runtime-chip]'), 'the chip').click());
    await settle();
    expect(popover()).not.toBeNull();
    await interact(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await settle();
    expect(popover()).toBeNull();
  });

  it('says once, quietly, inside the popover that the catalog cannot be read — never a red alert', async () => {
    const root = await draw(daemon(false).client);
    await interact(() => must(root.querySelector<HTMLElement>('[data-runtime-chip]'), 'the chip').click());
    await settle();

    const open = must(popover(), 'the popover');
    expect(open.querySelector('[role="alert"]')).toBeNull();
    const said = open.textContent?.match(/not connected to Ferrets yet/g) ?? [];
    expect(said).toHaveLength(1);
    // The reasoning levels do not need the catalog: they are still offered.
    expect(open.textContent).toContain('Low');
  });
});
