import {
  applyOverrides,
  DEFAULT_LAYOUT,
  type DeviceLayout,
  type LayoutOverrides,
  setDeviceOverride,
  type Viewport,
} from '@ferretry/app';
import { interact, mount, must } from '@ferretry/app/testing';
import { describe, expect, test } from 'bun:test';
import { useRef, useState } from 'react';
import app from '../../../app/index.ts';
import { LayoutStep } from '../../../app/features/onboarding/layout-step.tsx';
import { answerOf, keysFor, LAYOUT_QUESTIONS } from '../../../app/features/onboarding/layout-step-model.ts';
import manifest from '../../../manifest.ts';
import { stepRecorder } from '../../support/step-recorder.ts';
import type { StepHost } from '@ferretry/kernel/contract';

/** A device that behaves like the shell's: `set` goes through the real `setDeviceOverride`, and the page re-reads. */
function StatefulStep({
  step,
  writes,
  start = {},
  viewport = 'wide',
}: {
  readonly step: StepHost;
  readonly writes: string[];
  readonly start?: LayoutOverrides;
  readonly viewport?: Viewport;
}) {
  const [overrides, setOverrides] = useState<LayoutOverrides>(start);
  // The shell's store accumulates writes made in one handler; a state value alone would read the older one.
  const latest = useRef<LayoutOverrides>(overrides);
  const device: DeviceLayout = {
    overrides,
    base: DEFAULT_LAYOUT,
    inForce: applyOverrides(DEFAULT_LAYOUT, overrides) ?? DEFAULT_LAYOUT,
    set: (path, value) => {
      const edited = setDeviceOverride(DEFAULT_LAYOUT, latest.current, path, value);
      if (!edited.ok) return edited.error;
      writes.push(`${path}=${value}`);
      latest.current = edited.overrides;
      setOverrides(edited.overrides);
      return undefined;
    },
    reset: () => setOverrides({}),
  };
  return <LayoutStep step={step} device={device} viewport={viewport} />;
}

const group = (root: HTMLElement, label: string): HTMLElement =>
  must(root.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${label}"]`), `the ${label} choice`);
const checked = (root: HTMLElement, label: string): string | undefined =>
  group(root, label).querySelector<HTMLInputElement>('input:checked')?.value;
const pick = async (root: HTMLElement, label: string, word: string): Promise<void> => {
  const radio = must(group(root, label).querySelector<HTMLInputElement>(`input[value="${word}"]`), word);
  await interact(() => radio.click());
};

describe('the Layout step', () => {
  test('outside a shell there is no device to write to: it skips as not needed and draws nothing', async () => {
    const harness = stepRecorder();
    const view = await mount(<LayoutStep step={harness.host} device={undefined} viewport={undefined} />);
    expect(harness.decision).toBe('skipped');
    expect(harness.skippedWhy).toBe('not-needed');
    expect(view.container.textContent).toBe('');
    await view.unmount();
  });

  test('it shows itself once, as two short choice rows holding what this device shows today (no Left or Bottom on the built-in Top)', async () => {
    const harness = stepRecorder();
    const writes: string[] = [];
    const view = await mount(<StatefulStep step={harness.host} writes={writes} />);
    expect(harness.decision).toBe('shown');
    expect(harness.count('ready')).toBe(1);
    expect(harness.count('done')).toBe(0);
    expect(checked(view.container, 'Navigation')).toBe(undefined);
    expect(checked(view.container, 'Density')).toBe('comfortable');
    expect(view.container.textContent).toContain('Just this device');
    expect(writes).toEqual([]);
    await view.unmount();
  });

  test('answerOf reports what this device shows: Top on wide, Bottom on a phone, and an offered word as it is', () => {
    const [nav, density] = LAYOUT_QUESTIONS;
    const compact = { ...DEFAULT_LAYOUT, density: 'compact' as const };
    expect(answerOf(compact, density!, 'wide')).toBe('compact');
    expect(answerOf(DEFAULT_LAYOUT, nav!, 'wide')).toBe('top');
    expect(answerOf(DEFAULT_LAYOUT, nav!, 'phone')).toBe('bottom');
    expect(answerOf({ ...DEFAULT_LAYOUT, nav: { ...DEFAULT_LAYOUT.nav, side: 'left' } }, nav!, 'wide')).toBe('left');
    expect(answerOf({ ...DEFAULT_LAYOUT, nav: { ...DEFAULT_LAYOUT.nav, side: 'right' } }, nav!, 'wide')).toBe('right');
  });

  test('on the built-in layout the first Left press saves on a desktop and on a phone, and no card starts checked on a desktop', async () => {
    for (const viewport of ['wide', 'phone'] as const) {
      const harness = stepRecorder();
      const writes: string[] = [];
      const view = await mount(<StatefulStep step={harness.host} writes={writes} viewport={viewport} />);
      expect(checked(view.container, 'Navigation')).toBe(viewport === 'wide' ? undefined : 'bottom');
      await pick(view.container, 'Navigation', 'left');
      expect(writes).toEqual(['nav.side=left', 'phone.nav.side=left']);
      expect(checked(view.container, 'Navigation')).toBe('left');
      expect(harness.count('done')).toBe(1);
      await view.unmount();
    }
  });

  test('on a phone the card already showing, Bottom, saves nothing when pressed', async () => {
    const harness = stepRecorder();
    const writes: string[] = [];
    const view = await mount(<StatefulStep step={harness.host} writes={writes} viewport="phone" />);
    await pick(view.container, 'Navigation', 'bottom');
    expect(writes).toEqual([]);
    expect(harness.count('done')).toBe(0);
    await view.unmount();
  });

  test('picking Bottom writes nav.side to this device, with the phone key since the layout sets one, and answers done', async () => {
    const harness = stepRecorder();
    const writes: string[] = [];
    const view = await mount(<StatefulStep step={harness.host} writes={writes} />);
    await pick(view.container, 'Navigation', 'bottom');
    expect(writes).toEqual(['nav.side=bottom', 'phone.nav.side=bottom']);
    expect(checked(view.container, 'Navigation')).toBe('bottom');
    expect(harness.count('done')).toBe(1);
    await pick(view.container, 'Density', 'compact');
    expect(writes.at(-1)).toBe('density=compact');
    expect(checked(view.container, 'Density')).toBe('compact');
    expect(harness.count('done')).toBe(2);
    await view.unmount();
  });

  test('keysFor adds the phone key only when the layout in force sets one', () => {
    const [nav, density] = LAYOUT_QUESTIONS;
    expect(keysFor(DEFAULT_LAYOUT, nav!)).toEqual(['nav.side', 'phone.nav.side']);
    expect(keysFor({ ...DEFAULT_LAYOUT, phone: undefined }, nav!)).toEqual(['nav.side']);
    expect(keysFor({ ...DEFAULT_LAYOUT, phone: undefined }, density!)).toEqual(['density']);
  });

  test('a refusal is said in words, nothing is answered, and the choice does not move', async () => {
    const harness = stepRecorder();
    const device: DeviceLayout = {
      overrides: {},
      base: DEFAULT_LAYOUT,
      inForce: DEFAULT_LAYOUT,
      set: () => 'not a valid layout',
      reset: () => undefined,
    };
    const view = await mount(<LayoutStep step={harness.host} device={device} viewport="wide" />);
    await pick(view.container, 'Density', 'compact');
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('not a valid layout');
    expect(harness.count('done')).toBe(0);
    expect(checked(view.container, 'Density')).toBe('comfortable');
    await view.unmount();
  });

  test('the demo moves only for a card the person just chose, never for the one it opened on', async () => {
    const harness = stepRecorder();
    const view = await mount(<StatefulStep step={harness.host} writes={[]} />);
    const cards = (word: string) => must(view.container.querySelector<HTMLElement>(`[data-choice="${word}"]`), word);
    expect(cards('left').dataset.pulse).toBe('false');
    await pick(view.container, 'Navigation', 'bottom');
    expect(cards('bottom').dataset.pulse).toBe('true');
    expect(cards('left').dataset.pulse).toBe('false');
    expect(cards('bottom').querySelector('[data-moves]')).not.toBeNull();
    expect(cards('left').querySelector('[data-moves]')).toBeNull();
    await view.unmount();
  });

  test('it keeps nothing in browser storage: the saved device layout is the only memory', async () => {
    const writes: string[] = [];
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (...args) {
      writes.push(String(args[0]));
      return setItem.apply(this, args);
    };
    try {
      const harness = stepRecorder();
      const view = await mount(<StatefulStep step={harness.host} writes={[]} />);
      await pick(view.container, 'Navigation', 'bottom');
      await pick(view.container, 'Density', 'compact');
      expect(writes).toEqual([]);
      expect(harness.segment).toEqual({});
      await view.unmount();
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });
});

describe('the Layout step in the plugin', () => {
  test('the manifest declares one client step, layouts.layout, at order 2, with one panel in the slot', () => {
    expect(manifest.onboarding).toEqual([{ id: 'layout', title: 'Layout', order: 2, side: 'client', stepHost: true }]);
    const placed = (manifest.ui?.panels ?? []).filter(panel => panel.slot === 'onboarding.step');
    expect(placed.map(panel => panel.id)).toEqual(['onboarding-step']);
  });

  test('its panel is silent for every other step', () => {
    const half = app.build?.({ manifest, client: { call: async () => ({}) } as never });
    const panel = (half?.panels as Record<string, (props: { subject?: string }) => unknown> | undefined)?.[
      'onboarding-step'
    ];
    expect(panel?.({ subject: 'codex.harness' })).toBeNull();
    expect(panel?.({})).toBeNull();
  });
});
