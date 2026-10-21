import { afterEach, describe, expect, test } from 'bun:test';
import {
  SubFerretIndicator,
  SubFerretList,
  SubFerretsPack,
  subFerretItems,
} from '../../src/components/sub-ferrets.tsx';
import '../support/dom.ts';
import { interact, type Mounted, mount, must, pressKey } from '../support/dom.ts';
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

describe('the session bar’s sub-ferret indicator', () => {
  test('says how many and how they are doing, and opens a list that links to each', async () => {
    const opened: string[] = [];
    view = await mount(<SubFerretIndicator onOpenSession={id => opened.push(id)} sessions={pack} />);
    const toggle = must(view.container.querySelector<HTMLButtonElement>('[data-sub-ferret-toggle]'), 'the toggle');
    // Done is finished: not counted, not listed.
    expect(toggle.textContent).toBe('2 sub-ferrets · 1 needs you · 1 running');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.hasAttribute('aria-label')).toBe(false);
    expect(view.container.querySelector('[data-sub-ferret-popover]')).toBeNull();

    await interact(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const popover = must(view.container.querySelector('[data-sub-ferret-popover]'), 'the list');
    expect([...popover.querySelectorAll('[data-sub-ferret-state]')].map(state => state.textContent)).toEqual([
      'Working',
      'Needs you',
    ]);
    expect(popover.querySelector('.fy-sub-ferret-model')?.textContent).toBe('claude-opus-5-5');

    // Opening a sub-ferret closes the list.
    await interact(() => must(popover.querySelector<HTMLButtonElement>('[data-sub-ferret-open="k2"]'), 'k2').click());
    expect(opened).toEqual(['k2']);
    expect(view.container.querySelector('[data-sub-ferret-popover]')).toBeNull();
  });

  test('closes on Escape and on a press outside it, but not on a press inside it or another key', async () => {
    view = await mount(<SubFerretIndicator sessions={pack} />);
    const toggle = must(view.container.querySelector<HTMLButtonElement>('[data-sub-ferret-toggle]'), 'the toggle');
    await interact(() => toggle.click());
    await interact(() => pressKey(document, 'Enter'));
    const inside = must(view.container.querySelector('[data-sub-ferret-popover]'), 'the list');
    await interact(() => inside.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(view.container.querySelector('[data-sub-ferret-popover]')).not.toBeNull();
    await interact(() => pressKey(document, 'Escape'));
    expect(view.container.querySelector('[data-sub-ferret-popover]')).toBeNull();

    await interact(() => toggle.click());
    await interact(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(view.container.querySelector('[data-sub-ferret-popover]')).toBeNull();
    // With no way to navigate, the names are plain text.
    await interact(() => toggle.click());
    expect(view.container.querySelector('[data-sub-ferret-open]')).toBeNull();
    // And the toggle closes what it opened.
    await interact(() => toggle.click());
    expect(view.container.querySelector('[data-sub-ferret-popover]')).toBeNull();
  });

  test('counts and lists only the active, and draws nothing once every one has finished', async () => {
    const finished = [
      sessionView('f1', { config: { parent: 'lead' }, state: { status: 'completed' } }),
      sessionView('f2', { config: { parent: 'lead' }, state: { status: 'stopped' } }),
      sessionView('f3', { config: { parent: 'lead' }, state: { status: 'failed' } }),
    ];
    view = await mount(<SubFerretIndicator sessions={[...finished, ...pack.slice(0, 1)]} />);
    const toggle = must(view.container.querySelector<HTMLButtonElement>('[data-sub-ferret-toggle]'), 'the toggle');
    expect(toggle.textContent).toBe('1 sub-ferret · 1 running');
    await interact(() => toggle.click());
    expect(view.container.querySelectorAll('[data-sub-ferret]').length).toBe(1);
    await view.render(<SubFerretIndicator sessions={finished} />);
    expect(view.container.innerHTML).toBe('');
  });

  test('draws nothing for a ferret that started none', async () => {
    view = await mount(<SubFerretIndicator sessions={[]} />);
    expect(view.container.innerHTML).toBe('');
  });
});

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
