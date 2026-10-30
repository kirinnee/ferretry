import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaRevision } from '@ferretry/protocol';
import { AgendaRevisions } from '../../../src/features/agenda/agenda-revisions-view.tsx';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

describe('the revisions of an item', () => {
  test('draw nothing for an item nobody edited', async () => {
    view = await mount(<AgendaRevisions ferret="Zoe" item={agendaItem('A5')} now={NOW} />);
    expect(must(view.container, 'view').querySelector('[data-agenda-revisions]')).toBeNull();
  });

  test('list v3, v2, v1 newest first, with who and when, and every change before → after', async () => {
    const revisions = [
      { at: '2026-08-01T10:00:00.000Z', by: 'agent', changed: ['premise'], previous: { premise: 'Old premise' } },
      { at: '2026-08-01T11:00:00.000Z', by: 'human', changed: ['context'], previous: {} },
    ] as unknown as AgendaRevision[];
    view = await mount(
      <AgendaRevisions
        ferret="Zoe"
        item={agendaItem('A5', { premise: 'New premise', context: 'Fresh context', revisions })}
        now={NOW}
      />,
    );
    const root = must(view.container, 'view');
    const versions = [...root.querySelectorAll('li[data-agenda-version]')];
    expect(versions.map(version => version.getAttribute('data-agenda-version'))).toEqual(['3', '2', '1']);
    expect(versions[0]?.textContent).toContain('v3');
    expect(versions[0]?.textContent).toContain('You');
    expect(versions[0]?.querySelector('.fy-item-revisions__current')).not.toBeNull();
    expect(versions[1]?.textContent).toContain('Zoe');
    expect(versions[1]?.querySelector('.fy-item-revisions__current')).toBeNull();
    expect(versions[2]?.textContent).toContain('as first raised');
    const premise = must(root.querySelector('[data-field="premise"]'), 'the premise change');
    expect(premise.querySelector('[data-side="before"]')?.textContent).toContain('Old premise');
    expect(premise.querySelector('[data-side="after"]')?.textContent).toContain('New premise');
    const context = must(root.querySelector('[data-field="context"]'), 'the context change');
    expect(context.querySelector('[data-side="before"]')?.textContent).toContain('empty');
  });
});
