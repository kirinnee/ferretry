import { afterEach, describe, expect, test } from 'bun:test';
import { SubFerretList, SubFerretsPack, subFerretItems } from '../../src/components/sub-ferrets.tsx';
import '../support/dom.ts';
import { type Mounted, mount } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const pack = [
  sessionView('k1', {
    config: { parent: 'lead', teammate: 'nadia', model: 'claude-opus-5-5' },
    state: { status: 'running' },
  }),
  sessionView('k2', { config: { parent: 'lead', label: 'Sweep imports' }, state: { status: 'awaiting_user' } }),
  sessionView('k3', { config: { parent: 'lead', teammate: 'tomi' }, state: { status: 'completed' } }),
];

describe('Info’s pack', () => {
  test('the active ones show, the finished are behind a toggle, and a pack with none says so', async () => {
    const finished = sessionView('f1', { config: { parent: 'lead' }, state: { status: 'completed' } });
    view = await mount(<SubFerretsPack sessions={[...pack, finished]} />);
    expect(view.container.querySelectorAll('[data-sub-ferret]').length).toBe(2);
    await view.render(<SubFerretsPack sessions={pack.slice(0, 1)} />);
    expect(view.container.querySelector('[data-sub-ferret-finished-toggle]')).toBeNull();
    await view.render(<SubFerretsPack sessions={[finished]} />);
    expect(view.container.textContent).toContain('None active');
  });
});

describe('the sub-ferret list', () => {
  test('rows carry a reason when there is one', async () => {
    const failed = sessionView('k9', {
      config: { parent: 'lead' },
      state: { status: 'failed', reason: 'probe failed' },
    });
    view = await mount(<SubFerretList items={subFerretItems([failed])} />);
    expect(view.container.querySelector('.fy-sub-ferret-reason')?.textContent).toBe(' — probe failed');
  });
});
