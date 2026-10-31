import { afterEach, describe, expect, test } from 'bun:test';
import { JumpToLatest } from '../../src/components/jump-to-latest.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

let view: Mounted | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  host?.remove();
  host = null;
});

const pill = (root: ParentNode): HTMLButtonElement | null => root.querySelector<HTMLButtonElement>('.fy-jump-latest');

describe('JumpToLatest with a row of its own', () => {
  test('draws the pill, with the count, and jumps on a click', async () => {
    let jumps = 0;
    view = await mount(<JumpToLatest count={3} onJump={() => (jumps += 1)} shown />);
    const button = must(pill(view.container), 'the pill');
    expect(button.textContent).toContain('3 new — jump to latest');
    expect(button.hasAttribute('data-jump-hosted')).toBe(false);
    await interact(() => button.click());
    expect(jumps).toBe(1);
  });

  test('draws no row at all while the pill is hidden, so nothing sits above the composer', async () => {
    view = await mount(<JumpToLatest onJump={() => undefined} shown={false} />);
    expect(view.container.childElementCount).toBe(0);
  });
});

describe('JumpToLatest drawn in a host row', () => {
  test('puts the pill in the host, keeps no row of its own, and jumps on a click', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    let jumps = 0;
    view = await mount(<JumpToLatest host={host} onJump={() => (jumps += 1)} shown />);
    expect(view.container.querySelector('.fy-jump-latest-shell')).toBeNull();
    const button = must(pill(host), 'the hosted pill');
    expect(button.textContent).toContain('Jump to latest');
    expect(button.hasAttribute('data-jump-hosted')).toBe(true);
    await interact(() => button.click());
    expect(jumps).toBe(1);
  });

  test('draws nothing at all in the host while the pill is hidden', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    view = await mount(<JumpToLatest host={host} onJump={() => undefined} shown={false} />);
    expect(host.childElementCount).toBe(0);
    expect(view.container.childElementCount).toBe(0);
  });
});
