import { describe, expect, it } from 'bun:test';
import { type TabSpec, ViewTabs } from '../../src/components/view-tabs.tsx';
import { render, run } from '../support/react.ts';

type View = 'chat' | 'terminal';

const tabs: readonly TabSpec<View>[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'terminal', label: 'Terminal' },
];

describe('ViewTabs', () => {
  it('is a labelled group of toggle buttons, never a WAI-ARIA tablist', () => {
    const tree = render(<ViewTabs tabs={tabs} current="chat" onChange={() => {}} />);
    // A native fieldset already carries role=group, so the explicit role is gone
    // while the grouping semantics and the accessible name are not.
    const group = tree.root.findByType('fieldset');

    expect(group.props['aria-label']).toBe('View mode');
    expect(tree.root.findAllByProps({ role: 'tablist' }, { deep: true })).toHaveLength(0);
    expect(tree.root.findAllByProps({ role: 'tab' }, { deep: true })).toHaveLength(0);
  });

  it('marks the current view with aria-pressed rather than aria-selected', () => {
    const buttons = render(<ViewTabs tabs={tabs} current="terminal" onChange={() => {}} />).root.findAllByType(
      'button',
    );

    expect(buttons.map(button => button.props['aria-pressed'])).toEqual([false, true]);
    expect(buttons.every(button => button.props['aria-selected'] === undefined)).toBe(true);
    expect(buttons.every(button => button.props.type === 'button')).toBe(true);
    expect(buttons.every(button => button.props.className === 'kt-tab justify-center')).toBe(true);
  });

  it('reports the picked view exactly once per click', () => {
    const picked: View[] = [];
    const buttons = render(<ViewTabs tabs={tabs} current="chat" onChange={id => picked.push(id)} />).root.findAllByType(
      'button',
    );

    run(() => buttons[1]?.props.onClick());

    expect(picked).toEqual(['terminal']);
  });

  it('accepts a caller group label and extra track classes', () => {
    const group = render(
      <ViewTabs tabs={tabs} current="chat" onChange={() => {}} label="Session view" className="ml-2" />,
    ).root.findByType('fieldset');

    expect(group.props['aria-label']).toBe('Session view');
    expect(group.props.className).toBe(
      'inline-flex items-center rounded-control border border-border bg-surface-2 p-0.5 ml-2',
    );
  });

  it('renders a supplied icon alongside the label', () => {
    const tree = render(
      <ViewTabs
        tabs={[{ id: 'chat', label: 'Chat', icon: <svg role="presentation" /> }]}
        current="chat"
        onChange={() => {}}
      />,
    );

    expect(tree.root.findAllByType('svg')).toHaveLength(1);
  });
});
