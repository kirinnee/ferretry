import { describe, expect, test } from 'bun:test';
import { AgendaTab } from '../../../../app/features/agenda/agenda-tab.tsx';
import { agendaTabModel } from '../../../../app/lib/agenda-tab.ts';
import { agendaItem, choices } from '../../../support/app/agenda-inbox.tsx';
import { render, run } from '@ferretry/app/testing';
import { ensureDom } from '@ferretry/app/testing';
ensureDom();

describe('AgendaTab', () => {
  test('shows the current stages and asks, and opens the lead’s agenda from a sub-ferret', () => {
    const items = (['plan', 'tracker', 'test', 'explainer'] as const).map((stage, index) =>
      agendaItem(`A${String(index + 1)}`, {
        stage,
        title: `Current ${stage}`,
        subject: 'Continue with this approach?',
        ask: choices('Continue', 'Wait'),
        waitingOn: 'ferret',
        resting: { sub: 'working', at: '2026-08-01T09:00:00.000Z' },
      }),
    );
    const model = agendaTabModel({ items, resolved: [], ferret: 'Johnnie', now: Date.parse('2026-08-01T12:00:00Z') });
    let openedLead = 0;
    const opened: string[] = [];
    const view = render(
      <AgendaTab
        initial="resting"
        lead={{
          name: 'Denisha',
          open: () => {
            openedLead += 1;
          },
        }}
        model={model}
        onOpen={item => opened.push(item.id)}
      />,
    );
    try {
      const marks = view.root.findAll(
        node => node.type === 'span' && node.props['data-agenda-tab-stage'] !== undefined,
      );
      expect(marks.map(node => node.children.join(''))).toEqual(['Plan to approve', 'Tracker', 'Test', 'Explainer']);
      expect(view.root.findAllByProps({ 'data-agenda-row-ask': '' })).toHaveLength(4);
      const rows = view.root.findAll(node => node.type === 'button' && node.props['data-agenda-tab-row'] !== undefined);
      run(() => rows[0]?.props.onClick());
      expect(opened).toEqual(['A1']);
      run(() => view.root.findByProps({ className: 'fy-info-inline-action' }).props.onClick());
      expect(openedLead).toBe(1);
    } finally {
      run(() => view.unmount());
    }
  });
});
