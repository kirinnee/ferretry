import { afterEach, describe, expect, test } from 'bun:test';
import { type Mounted } from '../../support/dom.ts';
import { bootApp, entryOf, manifestOf, settle } from './frame-fixtures.tsx';

/** Each Settings item draws its icon beside its label, hidden from assistive tech; a group heading draws none. */
const demo = manifestOf('demo', {
  ui: {
    settings: [
      { id: 'one', label: 'Tab one', order: 10, group: 'supervision', icon: 'shield' },
      { id: 'two', label: 'Tab two', order: 11, group: 'health', icon: 'no-such-icon' },
    ],
  },
});
const demoEntry = entryOf(demo, { screens: {}, settings: { one: () => <p>one</p>, two: () => <p>two</p> } } as never);

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('the Settings list icons', () => {
  test('a tab and This device carry one aria-hidden icon with the label kept; a heading carries none; an unknown name draws nothing', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/d/d1/settings' });
    view = app.view;
    await settle();
    const nav = view.container.querySelector('nav[aria-label="Plugin settings"]') as HTMLElement;
    const link = (text: string) => [...nav.querySelectorAll('a')].find(a => a.textContent === text) as HTMLElement;
    for (const text of ['Tab one', 'This device']) {
      const icons = link(text).querySelectorAll('svg');
      expect(icons.length).toBe(1);
      expect(icons[0]?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(link('Tab two').querySelectorAll('svg').length).toBe(0);
    expect(nav.querySelectorAll('summary svg').length).toBe(0);
  });
});
