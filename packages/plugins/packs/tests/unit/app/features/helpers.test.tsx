import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { PackRow } from '../../../../contract/index.ts';
import { type Mounted, mount } from '../../support/dom.ts';
import { uiDoubles } from '../../support/ui-doubles.tsx';

mock.module('../../../../app/ui.ts', () => uiDoubles);
const { HelperList, HelpersPack, helperItems } = await import('../../../../app/components/helpers.tsx');

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const row = (id: string, overrides: Partial<PackRow> = {}): PackRow => ({
  id,
  name: id,
  parent: 'lead',
  depth: 1,
  model: 'claude-opus-5-5',
  state: 'running',
  ferretState: 'working',
  ...overrides,
});

const pack = [
  row('k1', { name: 'nadia' }),
  row('k2', { state: 'needs-you' }),
  row('k3', { name: 'tomi', state: 'ended', ferretState: 'stopped' }),
];

describe('the lead’s panel of helpers', () => {
  it('shows the active ones, keeps the finished behind a toggle, and says when none are active', async () => {
    view = await mount(<HelpersPack rows={pack} />);
    expect(view.container.querySelectorAll('[data-helper]').length).toBe(2);
    expect(view.container.querySelector('[data-helper-finished-toggle]')?.textContent).toBe('Show finished (1)');
    await view.render(<HelpersPack rows={pack.slice(0, 2)} />);
    expect(view.container.querySelector('[data-helper-finished-toggle]')).toBeNull();
    await view.render(<HelpersPack rows={pack.slice(2)} />);
    expect(view.container.textContent).toContain('None active');
  });
});

describe('the helper list', () => {
  it('rows carry a reason when there is one', async () => {
    const waiting = row('k9', {
      state: 'needs-you',
      last: { at: '2026-10-20T00:00:00.000Z' as never, source: 'note', text: 'Which branch?' },
    });
    view = await mount(<HelperList items={helperItems([waiting])} />);
    expect(view.container.querySelector('.fy-helper-reason')?.textContent).toBe(' — Which branch?');
  });
});
