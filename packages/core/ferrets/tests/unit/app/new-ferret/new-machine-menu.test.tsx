/**
 * S-0159, the `+ New` machine choice on the ferret list. Ported from today's `new-session-menu.test.tsx` (the default is
 * the machine on screen, a machine that is down is listed but not the default, a single machine keeps the plain link).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { deviceViewHarness, fakeReachRow } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  defaultNewFerretMachine,
  NewFerretButton,
  newFerretMachines,
  newFerretMenuItems,
} from '../../../../app/features/new-ferret/new-machine-menu.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

const client = {} as PluginClient;

describe('the machines a new ferret could start on', () => {
  it('should mark a machine whose feed is down as unavailable, saying which', () => {
    // Arrange
    const rows = [
      { daemon: 'alpha', machine: 'Desk', online: true },
      { daemon: 'beta', machine: 'Laptop', online: false },
    ];

    // Act
    const machines = newFerretMachines(rows);

    // Assert
    expect(machines).toEqual([
      { daemon: 'alpha', name: 'Desk' },
      { daemon: 'beta', name: 'Laptop', unavailable: 'Laptop isn’t reachable right now' },
    ]);
  });

  it('should default to the machine on screen while it is reachable', () => {
    // Arrange
    const machines = newFerretMachines([
      { daemon: 'alpha', machine: 'Desk', online: true },
      { daemon: 'beta', machine: 'Laptop', online: true },
    ]);

    // Act
    const chosen = defaultNewFerretMachine(machines, 'beta');

    // Assert
    expect(chosen).toBe('beta');
  });

  it('should default to the first reachable machine when the one on screen is down', () => {
    // Arrange
    const machines = newFerretMachines([
      { daemon: 'alpha', machine: 'Desk', online: false },
      { daemon: 'beta', machine: 'Laptop', online: false },
      { daemon: 'gamma', machine: 'Server', online: true },
    ]);

    // Act
    const chosen = defaultNewFerretMachine(machines, 'alpha');

    // Assert
    expect(chosen).toBe('gamma');
  });

  it('should have no default when every machine is down', () => {
    // Arrange
    const machines = newFerretMachines([{ daemon: 'alpha', machine: 'Desk', online: false }]);

    // Act
    const chosen = defaultNewFerretMachine(machines, 'alpha');

    // Assert
    expect(chosen).toBeUndefined();
  });

  it('should list the default first, mark the machine on screen, disable a machine that is down and navigate to its new-ferret page', () => {
    // Arrange
    const navigated: string[] = [];
    const machines = newFerretMachines([
      { daemon: 'alpha', machine: 'Desk', online: false },
      { daemon: 'beta', machine: 'Laptop', online: true },
      { daemon: 'gamma', machine: 'Server', online: true },
    ]);

    // Act
    const items = newFerretMenuItems(machines, 'alpha', to => navigated.push(to));
    items[0]?.onSelect?.();

    // Assert
    expect(items.map(item => item.label)).toEqual(['Laptop', 'Desk', 'Server']);
    expect(items[1]).toMatchObject({ detail: 'this one', disabled: true, hint: 'Desk isn’t reachable right now' });
    expect(navigated).toEqual(['/d/beta/new']);
  });

  it('should keep the machine on screen first when every machine is down', () => {
    // Arrange
    const machines = newFerretMachines([
      { daemon: 'alpha', machine: 'Desk', online: false },
      { daemon: 'beta', machine: 'Laptop', online: false },
    ]);

    // Act
    const items = newFerretMenuItems(machines, 'beta', () => undefined);

    // Assert
    expect(items.map(item => item.label)).toEqual(['Laptop', 'Desk']);
  });
});

describe('the + New ferret control', () => {
  let mounted: Mounted | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
  });

  const draw = async (
    rows: readonly { daemon: string; machine: string; online?: boolean }[],
    onNavigate: ((to: string) => void) | undefined,
  ): Promise<Mounted> => {
    const { Harness, setRows } = deviceViewHarness({ plugin: 'ferrets', fragments: [] });
    setRows(rows.map(row => fakeReachRow({ ...row, client })));
    return await mount(
      <Harness place="daemon">
        <NewFerretButton daemon="alpha" onNavigate={onNavigate} />
      </Harness>,
    );
  };

  it('should be the plain link to the machine on screen while the app reaches one machine', async () => {
    // Arrange / Act
    mounted = await draw([{ daemon: 'alpha', machine: 'Desk' }], () => undefined);

    // Assert
    const link = must(mounted.container.querySelector<HTMLAnchorElement>('a[data-ferret-new]'), 'the link');
    expect(link.getAttribute('href')).toBe('/d/alpha/new');
    expect(mounted.container.querySelector('button[data-new-ferret-machines]')).toBeNull();
  });

  it('should stay the plain link when the list has no way to navigate', async () => {
    // Arrange / Act
    mounted = await draw(
      [
        { daemon: 'alpha', machine: 'Desk' },
        { daemon: 'beta', machine: 'Laptop' },
      ],
      undefined,
    );

    // Assert
    expect(mounted.container.querySelector('a[data-ferret-new]')).not.toBeNull();
  });

  it('should ask which machine while the app reaches several, and start on the one chosen', async () => {
    // Arrange
    const navigated: string[] = [];
    mounted = await draw(
      [
        { daemon: 'alpha', machine: 'Desk' },
        { daemon: 'beta', machine: 'Laptop' },
      ],
      to => navigated.push(to),
    );
    expect(mounted.container.querySelector('a[data-ferret-new]')).toBeNull();

    // Act
    const trigger = must(
      mounted.container.querySelector<HTMLButtonElement>('button[data-new-ferret-machines]'),
      'the button',
    );
    await interact(() => trigger.click());
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const laptop = must(
      items.find(item => item.textContent?.includes('Laptop')),
      'the Laptop row',
    );
    await interact(() => laptop.click());

    // Assert
    expect(items.map(item => item.textContent)).toEqual([
      expect.stringContaining('Desk'),
      expect.stringContaining('Laptop'),
    ]);
    expect(navigated).toEqual(['/d/beta/new']);
  });
});
