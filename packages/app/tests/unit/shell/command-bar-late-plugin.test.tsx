import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import { provideToShell } from '../../../src/connect/provides.ts';
import { interact } from '../../support/dom.ts';
import { bootApp, entryOf, manifestOf, settle } from './frame-fixtures.tsx';

/**
 * THE COMMAND BAR OPENED BEFORE A MACHINE HAS SAID WHICH PLUGINS ARE ON (smoke path 6 follow-up): the first Ctrl+K
 * after a page loads listed no plugin's entries (no "New ferret", no ferrets), because the plugins' sources were built
 * once, while no plugin was allowed yet, and never again until the bar was closed and reopened. The sources follow the
 * set of plugins the machine allows.
 */

const manifest = manifestOf('doors', { ui: { screens: [{ id: 'new-door', path: 'new' }] } } as Partial<Manifest>);
const doors = provideToShell(implementApp(manifest, { build: () => ({}) }), {
  commands: context => () => [
    {
      id: 'doors-new',
      group: 'Go to',
      label: 'New door',
      description: 'Open a new door',
      keywords: ['new', 'start'],
      resting: true,
      order: 1100,
      run: () => context.navigate('/d/d1/new'),
    },
  ],
});

const openBar = async (): Promise<void> => {
  await interact(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  });
  await settle();
};

const barText = (): string => document.querySelector('[role="dialog"]')?.textContent ?? '';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the command bar and a plugin that is not allowed yet', () => {
  test('offers the plugin’s entry once the machine allows it, without closing and reopening the bar', async () => {
    const app = await bootApp({
      surfaces: [entryOf(manifest, doors)],
      machines: ['d1'],
      path: '/d/d1/ferrets',
      off: { d1: ['doors'] },
    });
    await openBar();
    expect(barText()).not.toContain('New door');

    app.machine('d1').off.delete('doors');
    await app.reread('d1');

    expect(barText()).toContain('New door');
    await app.view.unmount();
  });

  test('a plugin that is allowed from the start is offered at once', async () => {
    const app = await bootApp({ surfaces: [entryOf(manifest, doors)], machines: ['d1'], path: '/d/d1/ferrets' });
    await openBar();
    expect(barText()).toContain('New door');
    await app.view.unmount();
  });
});
