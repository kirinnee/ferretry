import { describe, expect, it } from 'bun:test';
import { StrictMode } from 'react';
import { placeSource } from '../../../src/shell/command-sources.ts';
import { routeTable } from '../../../src/router/routes.ts';
import { CommandBar } from '../../../src/ui/command-bar.tsx';
import { type CommandBarSource, commandBarResults } from '../../../src/ui/command-bar-model.ts';
import { interact, mount, must, pressKey } from '../../support/dom.ts';

const ran: string[] = [];
/** The bold line of each row: its label, without the sentence under it. */
const optionLabels = (): (string | null | undefined)[] =>
  [...document.body.querySelectorAll('[role="option"]')].map(
    option => option.querySelector('.font-semibold')?.textContent,
  );
const places: CommandBarSource = () => [
  { id: 'board', group: 'Go to', label: 'Board', resting: true, run: () => ran.push('board') },
  { id: 'agenda', group: 'Go to', label: 'Agenda', resting: true, run: () => ran.push('agenda') },
  { id: 'settings', group: 'Go to', label: 'Settings', keywords: ['theme'], run: () => ran.push('settings') },
];
const layout: CommandBarSource = () => [
  {
    id: 'nav-right',
    group: 'Layout on this device',
    label: 'Move the navigation to the right',
    run: () => ran.push('right'),
  },
];

describe('the command bar model', () => {
  it('shows resting entries with no query and ranks every entry by the query', () => {
    expect(commandBarResults([places, layout], '').results.map(entry => entry.id)).toEqual(['board', 'agenda']);
    expect(commandBarResults([places, layout], 'theme').results.map(entry => entry.id)).toEqual(['settings']);
    const grouped = commandBarResults([places, layout], 'r');
    expect(grouped.groups.map(group => group.heading)).toEqual(['Go to', 'Layout on this device']);
  });

  it('a source that throws costs only its own entries', () => {
    const broken: CommandBarSource = () => {
      throw new Error('a plugin broke');
    };
    expect(commandBarResults([broken, places], '').results).toHaveLength(2);
  });
});

// The bar is portalled to `document.body` (it must share a stacking context with the menus that portal there), so it is read
// from the body, not from the mount container.
describe('the command bar', () => {
  it('retains screen destinations after an empty query, typing, and closing/reopening in StrictMode', async () => {
    const screens = new Map([
      ['board.board', { plugin: 'board', id: 'board', path: 'board', label: 'Board', navOrder: 30 }],
      ['agenda.agenda', { plugin: 'agenda', id: 'agenda', path: 'agenda', label: 'Agenda', navOrder: 10 }],
    ]);
    const sources = [
      placeSource({
        daemons: [],
        daemon: 'demo',
        screens: screens.values(),
        routes: routeTable(screens.values()),
        navigate: () => {},
      }),
    ];
    const bar = (open: boolean, focusSignal: number) => (
      <StrictMode>
        <CommandBar open={open} focusSignal={focusSignal} onClose={() => {}} sources={sources} />
      </StrictMode>
    );
    const view = await mount(bar(true, 1));
    const labels = () => optionLabels();
    expect(labels()).toEqual(['Agenda', 'Board', 'Open settings', 'This device’s settings']);
    const input = must(document.body.querySelector<HTMLInputElement>('input[role="combobox"]'), 'query box');
    await interact(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'board');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('board');
    // The Board first; v4's "Open settings" is found too, its sentence holding b-o-a-r-d in order.
    expect(labels()).toEqual(['Board', 'Open settings']);
    expect(commandBarResults(sources, 'board').results[0]?.id).toBe('screen-board.board');
    await view.render(bar(false, 1));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await view.render(bar(true, 2));
    expect(document.body.querySelector<HTMLInputElement>('input')?.value).toBe('');
    expect(labels()).toEqual(['Agenda', 'Board', 'Open settings', 'This device’s settings']);
    await view.unmount();
  });

  it('K5: opens on a default list, never a blank panel — even with no machine paired', async () => {
    const sources = [
      placeSource({ daemons: [], daemon: undefined, screens: [], routes: routeTable([]), navigate: () => {} }),
    ];
    const view = await mount(<CommandBar open focusSignal={1} onClose={() => {}} sources={sources} />);
    expect(optionLabels()).toEqual(['Open settings']);
    expect(document.body.querySelector('[data-command-bar-resting]')).toBeNull();
    await view.unmount();
  });

  it('names a machine once: no subtitle that repeats the title, one only for an owner’s own label', () => {
    const base = {
      deviceId: 'dev',
      address: 'http://127.0.0.1:40245',
      carriers: [] as unknown[],
      pairedAt: 1,
      lastSelectedAt: 1,
    };
    const source = placeSource({
      daemons: [
        { ...base, daemon: 'a', machine: 'workshop-host' },
        { ...base, daemon: 'b', machine: 'attic-host', label: 'Attic' },
      ],
      daemon: undefined,
      screens: [],
      routes: routeTable([]),
      navigate: () => {},
    });
    const entries = commandBarResults([source], '').results.filter(entry => entry.id.startsWith('daemon-'));
    expect(entries.map(entry => [entry.label, entry.description])).toEqual([
      ['workshop-host', undefined],
      ['Attic', 'attic-host'],
    ]);
  });

  it('K5: when no source has anything at rest it says so, instead of a blank panel', async () => {
    const view = await mount(<CommandBar open focusSignal={1} onClose={() => {}} sources={[]} />);
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(document.body.querySelector('[data-command-bar-resting]')?.textContent).toContain('Type to search');
    await view.unmount();
  });

  it('renders nothing while closed', async () => {
    const view = await mount(<CommandBar open={false} focusSignal={0} onClose={() => {}} sources={[places]} />);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await view.unmount();
  });

  it('keeps focus in the query box, arrows through results and runs the active one on Enter', async () => {
    ran.length = 0;
    let closed = 0;
    const view = await mount(
      <CommandBar open focusSignal={1} onClose={() => (closed += 1)} sources={[places, layout]} />,
    );
    const input = must(document.body.querySelector<HTMLInputElement>('input[role="combobox"]'), 'the query box');
    expect(document.activeElement).toBe(input);
    const options = [...document.body.querySelectorAll('[role="option"]')];
    expect(options.map(option => option.textContent)).toEqual(['Board', 'Agenda']);
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id ?? null);
    await interact(() => pressKey(input, 'ArrowDown'));
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]?.id ?? null);
    await interact(() => pressKey(input, 'Enter'));
    expect(ran).toEqual(['agenda']);
    expect(closed).toBe(1);
    await view.unmount();
  });
});
