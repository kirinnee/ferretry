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

  test('it shows itself once, as two short stacked lists holding what this device shows today (the places at the foot of the side bar, as icons)', async () => {
    const harness = stepRecorder();
    const writes: string[] = [];
    const view = await mount(<StatefulStep step={harness.host} writes={writes} />);
    expect(harness.decision).toBe('shown');
    expect(harness.count('ready')).toBe(1);
    expect(harness.count('done')).toBe(0);
    expect(harness.committed).toBeNull();
    expect(checked(view.container, 'Navigation')).toBe('icons');
    expect(checked(view.container, 'Density')).toBe('comfortable');
    expect(view.container.textContent).toContain('This device only');
    expect(writes).toEqual([]);
    await view.unmount();
  });

  test('answerOf reports what this device shows: icons by default on wide and on a phone, words when asked, and density as stored', () => {
    const [nav, density] = LAYOUT_QUESTIONS;
    const compact = { ...DEFAULT_LAYOUT, density: 'compact' as const };
    expect(answerOf(compact, density!, 'wide')).toBe('compact');
    expect(answerOf(DEFAULT_LAYOUT, nav!, 'wide')).toBe('icons');
    expect(answerOf(DEFAULT_LAYOUT, nav!, 'phone')).toBe('icons');
    expect(answerOf({ ...DEFAULT_LAYOUT, nav: { ...DEFAULT_LAYOUT.nav, labels: 'words' } }, nav!, 'wide')).toBe(
      'words',
    );
  });

  test('on the built-in layout the Icons card starts checked on a desktop and on a phone, and pressing it saves nothing', async () => {
    for (const viewport of ['wide', 'phone'] as const) {
      const harness = stepRecorder();
      const writes: string[] = [];
      const view = await mount(<StatefulStep step={harness.host} writes={writes} viewport={viewport} />);
      expect(checked(view.container, 'Navigation')).toBe('icons');
      await pick(view.container, 'Navigation', 'icons');
      expect(writes).toEqual([]);
      expect(harness.count('done')).toBe(0);
      await view.unmount();
    }
  });

  test('no card of the step turns the bottom bar on: the choices are Icons, Words and the two densities, and a write never names nav.side', async () => {
    const [nav] = LAYOUT_QUESTIONS;
    expect(nav!.answers.map(answer => answer.id)).toEqual(['icons', 'words']);
    const harness = stepRecorder();
    const writes: string[] = [];
    const view = await mount(<StatefulStep step={harness.host} writes={writes} />);
    expect(view.container.querySelector('[data-choice="bottom"]')).toBeNull();
    await pick(view.container, 'Navigation', 'words');
    await pick(view.container, 'Density', 'compact');
    await interact(() => harness.committed?.());
    expect(writes.join(' ')).not.toContain('bottom');
    expect(writes.join(' ')).not.toContain('nav.side');
    await view.unmount();
  });

  test('a pick only registers the save: nothing is written until Next runs it, and the shell (not the page) answers done', async () => {
    const harness = stepRecorder();
    const writes: string[] = [];
    const view = await mount(<StatefulStep step={harness.host} writes={writes} />);
    await pick(view.container, 'Navigation', 'words');
    expect(writes).toEqual([]);
    expect(checked(view.container, 'Navigation')).toBe('words');
    expect(harness.committed).not.toBeNull();
    await pick(view.container, 'Density', 'compact');
    expect(writes).toEqual([]);
    expect(checked(view.container, 'Density')).toBe('compact');
    await interact(() => harness.committed?.());
    expect(writes).toEqual(['nav.labels=words', 'density=compact']);
    expect(harness.count('done')).toBe(0);
    expect(harness.count('busy')).toBe(0);
    await view.unmount();
  });

  test('picking back the answer the device already shows clears the save, and only the changed answer is written', async () => {
    const harness = stepRecorder();
    const writes: string[] = [];
    const view = await mount(<StatefulStep step={harness.host} writes={writes} />);
    await pick(view.container, 'Navigation', 'words');
    await pick(view.container, 'Navigation', 'icons');
    expect(harness.committed).toBeNull();
    expect(harness.calls.at(-1)).toBe('commit:clear');
    await pick(view.container, 'Density', 'compact');
    await interact(() => harness.committed?.());
    expect(writes).toEqual(['density=compact']);
    await view.unmount();
  });

  test('keysFor adds the phone key only when the layout in force sets one, for density and for the labels', () => {
    const [nav, density] = LAYOUT_QUESTIONS;
    expect(keysFor({ ...DEFAULT_LAYOUT, phone: { density: 'compact' } }, density!)).toEqual([
      'density',
      'phone.density',
    ]);
    expect(keysFor({ ...DEFAULT_LAYOUT, phone: { nav: { labels: 'words' } } }, nav!)).toEqual([
      'nav.labels',
      'phone.nav.labels',
    ]);
    expect(keysFor({ ...DEFAULT_LAYOUT, phone: { density: 'compact' } }, nav!)).toEqual(['nav.labels']);
    expect(keysFor(DEFAULT_LAYOUT, nav!)).toEqual(['nav.labels']);
    expect(keysFor({ ...DEFAULT_LAYOUT, phone: undefined }, density!)).toEqual(['density']);
  });

  test('a refusal is thrown to the shell in words, the picks stay, and a second Next tries again', async () => {
    const harness = stepRecorder();
    let refuse = true;
    const device: DeviceLayout = {
      overrides: {},
      base: DEFAULT_LAYOUT,
      inForce: DEFAULT_LAYOUT,
      set: () => (refuse ? 'not a valid layout' : undefined),
      reset: () => undefined,
    };
    const view = await mount(<LayoutStep step={harness.host} device={device} viewport="wide" />);
    await pick(view.container, 'Density', 'compact');
    let refusal = '';
    await interact(async () => {
      await harness.committed?.().catch((error: Error) => {
        refusal = error.message;
      });
    });
    expect(refusal).toBe('not a valid layout');
    expect(checked(view.container, 'Density')).toBe('compact');
    expect(harness.count('done')).toBe(0);
    refuse = false;
    await interact(() => harness.committed?.());
    await view.unmount();
  });

  test('the demo is one picture in the frame-less fallback, follows the picks, and moves only the part just picked', async () => {
    const harness = stepRecorder();
    const view = await mount(<StatefulStep step={harness.host} writes={[]} />);
    const demo = () => must(view.container.querySelector<HTMLElement>('[data-layout-demo]'), 'the demo');
    expect(view.container.querySelectorAll('[data-layout-demo]')).toHaveLength(1);
    expect(demo().dataset.labels).toBe('icons');
    expect(demo().querySelector('[data-moves]')).toBeNull();
    await pick(view.container, 'Navigation', 'words');
    expect(demo().dataset.labels).toBe('words');
    expect(demo().dataset.density).toBe('comfortable');
    expect(demo().querySelectorAll('[data-moves]')).toHaveLength(1);
    expect(demo().querySelector('.fy-lstep-demo__dock')?.hasAttribute('data-moves')).toBe(true);
    await pick(view.container, 'Density', 'compact');
    expect(demo().dataset.density).toBe('compact');
    expect(demo().querySelector('.fy-lstep-demo__page')?.hasAttribute('data-moves')).toBe(true);
    expect(demo().querySelector('.fy-lstep-demo__dock')?.hasAttribute('data-moves')).toBe(false);
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
      await pick(view.container, 'Navigation', 'words');
      await pick(view.container, 'Density', 'compact');
      await interact(() => harness.committed?.());
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
