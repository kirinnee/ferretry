import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp } from '@ferretry/kernel/manifest';
import { provideToShell } from '../../../src/connect/provides.ts';
import { storedOverrides } from '../../../src/layout/device-layout.ts';
import { APP_STORAGE } from '../../../src/storage/names.ts';
import { memoryStore, writeRecord } from '../../../src/storage/records.ts';
import type { Mounted } from '../../support/dom.ts';
import { bootApp, entryOf, manifestOf } from './frame-fixtures.tsx';

/** end B5: on Home the nav's own "Daemons" place is the one marked current, never a plugin's place; the phone bar reads the same targets. */

const demo = manifestOf('demo', {
  ui: { screens: [{ id: 'projects', path: 'projects', nav: { label: 'Projects', order: 1 } }] },
});
const demoEntry = entryOf(
  demo,
  provideToShell(implementApp(demo, { build: () => ({ screens: { projects: () => <p>projects page</p> } }) }), {}),
);

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const bar = async (path: string, side: 'bottom' | 'left') => {
  const storage = memoryStore();
  writeRecord(
    storage,
    APP_STORAGE.layout,
    storedOverrides({
      nav: { items: ['daemons', 'demo.projects', 'settings'] },
      'composer.tools': [],
      panels: { 'ferret.side': [] },
      side: { holds: 'none' },
      phone: { nav: { side } },
    }),
  );
  const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path, viewport: 'phone', storage });
  view = app.view;
  return [...app.view.container.querySelectorAll('nav .fy-nav__item[aria-current="page"]')].map(a => a.textContent);
};

describe('the nav marks the place on screen (end B5)', () => {
  test('Home: Daemons is current and Projects is not', async () => {
    expect(await bar('/', 'bottom')).toEqual(['Daemons']);
  });
  test("a machine's home: Daemons is current and Projects is not", async () => {
    expect(await bar('/d/d1', 'bottom')).toEqual(['Daemons']);
  });
  test("a machine's Projects page: Projects alone", async () => {
    expect(await bar('/d/d1/projects', 'bottom')).toEqual(['Projects']);
  });
});
