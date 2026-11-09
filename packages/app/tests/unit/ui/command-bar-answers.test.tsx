import { describe, expect, it } from 'bun:test';
import { CommandBar } from '../../../src/ui/command-bar.tsx';
import {
  type CommandBarAnswer,
  type CommandBarEntry,
  type CommandBarSource,
  commandBarFilters,
  commandBarResults,
  resolveChoices,
} from '../../../src/ui/command-bar-model.ts';
import { interact, mount, must } from '../../support/dom.ts';

const entry = (id: string, extra: Partial<CommandBarEntry> = {}): CommandBarEntry => ({
  id,
  group: 'Cards',
  label: id,
  run: () => {},
  ...extra,
});

/** A source that records what it was asked and answers from a script. */
function scripted(
  answer: (query: string, filters: Readonly<Record<string, string>>) => CommandBarAnswer | CommandBarEntry[],
) {
  const asked: { query: string; filters: Readonly<Record<string, string>> }[] = [];
  const source: CommandBarSource = {
    filters: [
      {
        id: 'kind',
        label: 'Kind',
        options: [
          { id: 'all', label: 'All' },
          { id: 'task', label: 'Cards' },
        ],
      },
      {
        id: 'state',
        label: 'State',
        options: [
          { id: 'everything', label: 'Everything' },
          { id: 'open', label: 'Open' },
        ],
      },
    ],
    list: (query, filters) => {
      asked.push({ query, filters });
      return answer(query, filters);
    },
  };
  return { source, asked };
}

const typeInto = async (container: HTMLElement, text: string): Promise<void> => {
  const input = must(container.querySelector<HTMLInputElement>('input[role="combobox"]'), 'query box');
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const chip = (container: HTMLElement, label: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll<HTMLButtonElement>('[data-command-bar-filters] button')].find(
      button => button.textContent === label,
    ),
    `the ${label} chip`,
  );

describe('S11 a command bar answer that can say more', () => {
  it('S11 a plain function source is unchanged, alone or beside an object source', () => {
    const plain: CommandBarSource = () => [entry('plain', { resting: true })];
    const { source } = scripted(() => [entry('rich', { resting: true })]);
    expect(commandBarResults([plain], '').results.map(each => each.id)).toEqual(['plain']);
    expect(commandBarResults([plain, source], '').results.map(each => each.id)).toEqual(['plain', 'rich']);
    expect(commandBarFilters([plain])).toEqual([]);
  });

  it('S11 chips change what the source is asked: every filter at its first option, then the choice', () => {
    const { source, asked } = scripted(() => []);
    commandBarResults([source], 'x');
    expect(asked.at(-1)?.filters).toEqual({ kind: 'all', state: 'everything' });
    commandBarResults([source], 'x', { kind: 'task', state: 'open' });
    expect(asked.at(-1)?.filters).toEqual({ kind: 'task', state: 'open' });
    // A choice that is not one of the filter's options falls back to its first
    commandBarResults([source], 'x', { kind: 'nonsense' });
    expect(asked.at(-1)?.filters).toEqual({ kind: 'all', state: 'everything' });
  });

  it('S11 an answer object lists entries and says pending; a plain array says none', () => {
    const { source } = scripted(() => ({
      entries: [entry('a', { resting: true })],
      pending: 'Searching cards and agenda…',
    }));
    const found = commandBarResults([source], '');
    expect(found.results.map(each => each.id)).toEqual(['a']);
    expect(found.pending).toBe('Searching cards and agenda…');
    expect(commandBarResults([scripted(() => [entry('b', { resting: true })]).source], '').pending).toBeUndefined();
  });

  it('S11 a source that throws costs only its own entries, an object source too', () => {
    const broken: CommandBarSource = {
      list: () => {
        throw new Error('boom');
      },
    };
    const plain: CommandBarSource = () => [entry('p', { resting: true })];
    expect(commandBarResults([broken, plain], '').results.map(each => each.id)).toEqual(['p']);
  });

  it('S11 a filter id offered twice is offered once, and a filter without options is not offered', () => {
    const a = scripted(() => []).source;
    const b = scripted(() => []).source;
    const empty: CommandBarSource = { list: () => [], filters: [{ id: 'none', label: 'None', options: [] }] };
    expect(commandBarFilters([a, b, empty]).map(filter => filter.id)).toEqual(['kind', 'state']);
    expect(resolveChoices(commandBarFilters([a]), { kind: 'task' })).toEqual({ kind: 'task', state: 'everything' });
  });

  it('S11 the bar draws chips while searching, asks again on a chip, and keeps typing focus', async () => {
    const { source, asked } = scripted((query, filters) => [
      entry(`${query}-${filters.kind}-${filters.state}`, { label: `${query} ${filters.kind} ${filters.state}` }),
    ]);
    const view = await mount(<CommandBar open focusSignal={1} onClose={() => {}} sources={[source]} />);
    expect(view.container.querySelector('[data-command-bar-filters]')).toBeNull(); // nothing typed: no chips
    await typeInto(view.container, 'bar');
    expect(chip(view.container, 'All').getAttribute('aria-pressed')).toBe('true');
    expect(chip(view.container, 'Everything').getAttribute('aria-pressed')).toBe('true');
    expect(view.container.querySelector('[role="option"]')?.textContent).toContain('bar all everything');
    await interact(() => chip(view.container, 'Cards').click());
    await interact(() => chip(view.container, 'Open').click());
    expect(chip(view.container, 'Cards').getAttribute('aria-pressed')).toBe('true');
    expect(chip(view.container, 'All').getAttribute('aria-pressed')).toBe('false');
    expect(view.container.querySelector('[role="option"]')?.textContent).toContain('bar task open');
    expect(asked.at(-1)?.filters).toEqual({ kind: 'task', state: 'open' });
    await view.unmount();
  });

  it('S11 the chips are forgotten when the bar closes', async () => {
    const { source } = scripted(() => [entry('x')]);
    const bar = (open: boolean) => <CommandBar open={open} focusSignal={1} onClose={() => {}} sources={[source]} />;
    const view = await mount(bar(true));
    await typeInto(view.container, 'x');
    await interact(() => chip(view.container, 'Cards').click());
    await view.render(bar(false));
    await view.render(bar(true));
    await typeInto(view.container, 'x');
    expect(chip(view.container, 'All').getAttribute('aria-pressed')).toBe('true');
    await view.unmount();
  });

  it('S11 the pending line shows while nothing is listed, then clears; "Nothing matches" waits for the answer', async () => {
    let waiting = true;
    const { source } = scripted(() =>
      waiting ? { entries: [], pending: 'Searching cards and agenda…' } : { entries: [] },
    );
    const bar = (tick: number) => <CommandBar open focusSignal={tick} onClose={() => {}} sources={[{ ...source }]} />;
    const view = await mount(bar(1));
    await typeInto(view.container, 'hello');
    expect(view.container.querySelector('[data-command-bar-pending]')?.textContent).toBe('Searching cards and agenda…');
    expect(view.container.textContent).not.toContain('Nothing matches');
    expect(view.container.querySelector('[data-command-bar-filters]')?.getAttribute('aria-busy')).toBe('true');
    waiting = false;
    await view.render(bar(2));
    await typeInto(view.container, 'hello!');
    expect(view.container.querySelector('[data-command-bar-pending]')).toBeNull();
    expect(view.container.textContent).toContain('Nothing matches');
    await view.unmount();
  });

  it('S11 muted rows and a detail line are drawn; plain rows carry neither', async () => {
    const { source } = scripted(() => [
      entry('closed', { label: 'closed card', muted: true, detail: 'Unfiled', description: 'done' }),
      entry('live', { label: 'live card' }),
    ]);
    const view = await mount(<CommandBar open focusSignal={1} onClose={() => {}} sources={[source]} />);
    await typeInto(view.container, 'card');
    const rows = [...view.container.querySelectorAll('[role="option"]')];
    const closed = must(
      rows.find(row => row.textContent?.includes('closed card')),
      'closed row',
    );
    const live = must(
      rows.find(row => row.textContent?.includes('live card')),
      'live row',
    );
    expect(closed.getAttribute('data-muted')).toBe('true');
    expect(closed.className).toContain('opacity-70');
    expect(closed.querySelector('[data-command-bar-detail]')?.textContent).toBe('Unfiled');
    expect(live.getAttribute('data-muted')).toBeNull();
    expect(live.className).not.toContain('opacity-70');
    expect(live.querySelector('[data-command-bar-detail]')).toBeNull();
    await view.unmount();
  });

  it('S11 an empty detail draws no line', async () => {
    const { source } = scripted(() => [entry('e', { label: 'e card', detail: '' })]);
    const view = await mount(<CommandBar open focusSignal={1} onClose={() => {}} sources={[source]} />);
    await typeInto(view.container, 'card');
    expect(view.container.querySelector('[data-command-bar-detail]')).toBeNull();
    await view.unmount();
  });
});
