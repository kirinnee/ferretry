import { afterEach, describe, expect, it } from 'bun:test';
import {
  subFerretItems,
  subFerretLive,
  SubFerretsPack,
  subFerretState,
} from '../../../../app/features/info/sub-ferrets.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { ferretOf } from './fixtures.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('subFerretState', () => {
  it('reads how a sub-ferret is doing from its record', () => {
    expect(subFerretState(ferretOf('a', { state: 'starting' })).state).toBe('starting');
    expect(subFerretState(ferretOf('a', { state: 'working' })).state).toBe('working');
    expect(subFerretState(ferretOf('a', { state: 'idle' })).word).toBe('At its prompt');
    expect(subFerretState(ferretOf('a', { state: 'stopped' })).state).toBe('stopped');
  });

  it('calls a stopped ferret that said it was done Done, not Stopped', () => {
    expect(subFerretState(ferretOf('a', { state: 'stopped', finishedAt: '2026-11-07T11:00:00.000Z' })).state).toBe(
      'done',
    );
  });

  it('says a declared wait, with what it is waiting on', () => {
    const read = subFerretState(
      ferretOf('a', { state: 'working', waiting: { since: '2026-11-07T11:00:00.000Z', condition: 'CI to finish' } }),
    );
    expect(read).toMatchObject({ state: 'waiting', reason: 'CI to finish' });
    expect(subFerretLive(read)).toBe(true);
  });

  it('counts done and stopped as no longer at work', () => {
    expect(subFerretLive(subFerretState(ferretOf('a', { state: 'stopped' })))).toBe(false);
  });
});

describe('subFerretItems', () => {
  it('names each by callsign, else task, else short id, with its model, and opens through the host', () => {
    const opened: string[] = [];
    const items = subFerretItems(
      [ferretOf('c1', { name: 'ms-98', model: 'opus' }), ferretOf('c2', { name: '', title: 'Write docs' })].filter(
        Boolean,
      ),
      id => opened.push(id),
    );
    expect(items[0]).toMatchObject({ id: 'c1', name: 'Ms-98', model: 'opus' });
    items[0]?.onOpen?.();
    expect(opened).toEqual(['c1']);
  });
});

describe('SubFerretsPack', () => {
  it('lists the active ones and keeps the finished ones behind a toggle', async () => {
    const opened: string[] = [];
    mounted = await mount(
      <SubFerretsPack
        ferrets={[
          ferretOf('c1', { name: 'rin', state: 'working' }),
          ferretOf('c2', { name: 'sol', state: 'stopped', finishedAt: '2026-11-07T11:00:00.000Z' }),
        ]}
        onOpenFerret={id => opened.push(id)}
      />,
    );
    const root = mounted.container;
    expect(root.querySelectorAll('[data-sub-ferret]').length).toBe(1);
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-sub-ferret-open="c1"]'), 'link').click());
    expect(opened).toEqual(['c1']);

    const toggle = must(root.querySelector<HTMLButtonElement>('[data-sub-ferret-finished-toggle]'), 'toggle');
    expect(toggle.textContent).toBe('Show finished (1)');
    await interact(() => toggle.click());
    expect(root.querySelectorAll('[data-sub-ferret]').length).toBe(2);
    expect(toggle.textContent).toBe('Hide finished (1)');
  });

  it('says none are active when only finished ones are left', async () => {
    mounted = await mount(<SubFerretsPack ferrets={[ferretOf('c2', { state: 'stopped' })]} />);
    expect(mounted.container.textContent).toContain('None active');
  });
});
