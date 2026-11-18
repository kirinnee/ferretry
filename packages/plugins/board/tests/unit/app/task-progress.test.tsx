import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, settleUntil } from '@ferretry/app/testing';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { createElement, type FunctionComponent, Suspense } from 'react';
import { createSurfaces } from '../../../app/views/surfaces.tsx';

/** `card.detail`: one task's progress. A read that fails is over — the words say so and the shell's top bar is released. */

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const refusing = {
  call: async () => {
    throw new Error('the machine did not answer');
  },
  subscribe: () => () => undefined,
} as unknown as PluginClient;

describe('the card-progress panel when the read fails', () => {
  it('says the task could not be read and holds no background load', async () => {
    const panel = createSurfaces(refusing).panels['card-progress'] as FunctionComponent<PanelProps>;
    view = await mount(
      createElement(Suspense, { fallback: null }, createElement(panel, { subject: 'f1' } as PanelProps)),
    );
    const root = view.container;
    await settleUntil(
      () => root.querySelector('[role="alert"]') !== null,
      () => `drew: ${root.textContent ?? ''}`,
      interact,
    );
    expect(root.textContent).toContain('F1 could not be read');
    expect(root.querySelector('[data-loading="background"]')).toBeNull();
  });
});
