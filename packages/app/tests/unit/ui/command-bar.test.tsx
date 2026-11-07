import { describe, expect, it } from 'bun:test';
import { CommandBar } from '../../../src/ui/command-bar.tsx';
import { type CommandBarSource, commandBarResults } from '../../../src/ui/command-bar-model.ts';
import { interact, mount, must, pressKey } from '../../support/dom.ts';

const ran: string[] = [];
const places: CommandBarSource = () => [
  { id: 'board', group: 'Go to', label: 'Board', resting: true, run: () => ran.push('board') },
  { id: 'agenda', group: 'Go to', label: 'Agenda', resting: true, run: () => ran.push('agenda') },
  { id: 'settings', group: 'Go to', label: 'Settings', keywords: ['theme'], run: () => ran.push('settings') },
];
const layout: CommandBarSource = () => [
  { id: 'nav-right', group: 'Layout on this device', label: 'Move the navigation to the right', run: () => ran.push('right') },
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

describe('the command bar', () => {
  it('renders nothing while closed', async () => {
    const view = await mount(<CommandBar open={false} focusSignal={0} onClose={() => {}} sources={[places]} />);
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps focus in the query box, arrows through results and runs the active one on Enter', async () => {
    ran.length = 0;
    let closed = 0;
    const view = await mount(
      <CommandBar open focusSignal={1} onClose={() => (closed += 1)} sources={[places, layout]} />,
    );
    const input = must(view.container.querySelector<HTMLInputElement>('input[role="combobox"]'), 'the query box');
    expect(document.activeElement).toBe(input);
    const options = [...view.container.querySelectorAll('[role="option"]')];
    expect(options.map(option => option.textContent)).toEqual(['Board', 'Agenda']);
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id ?? null);
    await interact(() => pressKey(input, 'ArrowDown'));
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]?.id ?? null);
    await interact(() => pressKey(input, 'Enter'));
    expect(ran).toEqual(['agenda']);
    expect(closed).toBe(1);
  });
});
