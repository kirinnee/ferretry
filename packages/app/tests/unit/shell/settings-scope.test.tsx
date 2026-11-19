import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEVICE_BLOCK_HEADING, SCOPE_WORDS, scopeOf, splitTabsByScope } from '../../../src/shell/settings-tab.ts';
import type { Mounted } from '../../support/dom.ts';
import { bootApp, entryOf, manifestOf, settle } from './frame-fixtures.tsx';

/**
 * R10 S1, THE SETTINGS FRAME: the list is split by WHERE a setting is kept (this browser / the machine), the chip says it per
 * tab, the page has one h1, and the stylesheet's label rule no longer turns a flex label into a block.
 */

const demo = manifestOf('demo', {
  ui: {
    settings: [
      { id: 'one', label: 'Tab one', order: 10, group: 'supervision' },
      { id: 'mine', label: 'Mine only', order: 11, group: 'behaviour', scope: 'device' },
      { id: 'two', label: 'Tab two', order: 12, group: 'health' },
      { id: 'own', label: 'Own switch', order: 13, group: 'behaviour', scope: 'device', scopeChip: false },
    ],
  },
});
const demoEntry = entryOf(demo, {
  screens: {},
  settings: { one: () => <p>one</p>, mine: () => <p>mine</p>, two: () => <p>two</p>, own: () => <p>own</p> },
} as never);

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});
const q = (selector: string): Element | null => view?.container.querySelector(selector) ?? null;
const all = (selector: string): Element[] => [...(view?.container.querySelectorAll(selector) ?? [])];

describe('a tab’s scope', () => {
  test('defaults to the machine, and splits the list keeping each side’s order', () => {
    expect(scopeOf({})).toBe('machine');
    expect(scopeOf({ scope: 'device' })).toBe('device');
    const split = splitTabsByScope([
      { id: 'a' },
      { id: 'b', scope: 'device' as const },
      { id: 'c', scope: 'machine' as const },
    ]);
    expect(split.device.map(tab => tab.id)).toEqual(['b']);
    expect(split.machine.map(tab => tab.id)).toEqual(['a', 'c']);
  });
});

describe('the Settings list is split by where a setting is kept', () => {
  test('two headed blocks: this browser first (with the device page and device tabs), then the machine', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/d/d1/settings' });
    view = app.view;
    await settle();
    const blocks = all('.fy-settings-nav .fy-settings-block').map(block => ({
      heading: block.querySelector('.fy-settings-block__title')?.textContent,
      links: [...block.querySelectorAll('a')].map(link => link.textContent),
    }));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.heading).toBe(DEVICE_BLOCK_HEADING);
    expect(blocks[0]?.links).toEqual(['This device', 'Mine only', 'Own switch']);
    expect(blocks[1]?.heading).toMatch(/ · every device$/);
    expect(blocks[1]?.links).toEqual(['Tab one', 'Tab two']);
  });

  test('a tab appears in exactly one block (one Layout entry, never one per scope)', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/d/d1/settings' });
    view = app.view;
    await settle();
    const labels = all('.fy-settings-nav a').map(link => link.textContent);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('the scope chip follows the tab on screen', () => {
  test('a machine tab says it is the machine’s, for every device', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/d/d1/settings/demo/two' });
    view = app.view;
    await settle();
    expect(q('.fy-settings-machine__scope')?.textContent).toBe(SCOPE_WORDS.machine);
    expect(q('.fy-settings-machine__scope')?.getAttribute('data-scope')).toBe('machine');
  });

  test('a device tab says it is only this browser', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/d/d1/settings/demo/mine' });
    view = app.view;
    await settle();
    expect(q('.fy-settings-machine__scope')?.textContent).toBe('Only this browser');
    expect(q('.fy-settings-machine__scope')?.getAttribute('data-scope')).toBe('device');
  });

  test('a tab that says where it saves itself (scopeChip: false) shows no fixed chip', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/d/d1/settings/demo/own' });
    view = app.view;
    await settle();
    expect(q('.fy-settings-machine__scope')).toBeNull();
  });

  test('a phone’s list (no tab open) claims no scope', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/d/d1/settings', viewport: 'phone' });
    view = app.view;
    await settle();
    expect(q('.fy-settings-machine__scope')).toBeNull();
  });
});

describe('one h1 on a settings page (2016)', () => {
  for (const viewport of ['wide', 'phone'] as const) {
    test(`${viewport}: the list and an open panel each name the page once`, async () => {
      for (const path of ['/d/d1/settings', '/d/d1/settings/demo/two']) {
        const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path, viewport });
        view = app.view;
        await settle();
        expect(all('h1')).toHaveLength(1);
        await view.unmount();
        view = null;
      }
    });
  }
});

describe('the stylesheet’s label and nav rules', () => {
  const css = readFileSync(fileURLToPath(new URL('../../../src/styles/shell.css', import.meta.url)), 'utf8');
  const rule = (selector: string): string => {
    const start = css.indexOf(`\n${selector} {`);
    return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
  };

  test('only a form’s bare label is a block: a flex label keeps its own layout', () => {
    expect(css).not.toMatch(/\.fy-page label\s*[{,]/);
    expect(rule('.fy-page form > label:not([class])')).toContain('display: block');
  });

  test('nav text is the body colour, never the link accent; the current item gets the bar', () => {
    expect(rule('.fy-settings-nav .fy-tab')).toContain('color: var(--fg)');
    expect(css).toMatch(/\.fy-settings-nav \.fy-tab--active,[^{]*\{[^}]*inset 3px 0 0 var\(--accent\)/);
  });

  test('groups stand 32px apart and the content is at most 1,100px wide', () => {
    expect(rule('.fy-page [data-setting-group]')).toContain('margin-bottom: 32px');
    expect(rule('.fy-settings-page')).toContain('max-width: 1100px');
  });
});
