import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem, AgendaVersionList } from '@ferretry/protocol';
import { AgendaItemCard } from '../../../src/features/agenda/agenda-item-card.tsx';
import { agendaProse } from '../../../src/features/agenda/agenda-prose.tsx';
import type { AgendaMergeView, AgendaVersionsView } from '../../../src/features/agenda/use-item-lifecycle.ts';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { settleUntil } from '../../support/settle.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const at = new Date(NOW - 3_600_000).toISOString();
const list = {
  sessionId: 's',
  id: 'A5',
  latest: 2,
  seen: 1,
  versions: [1, 2].map(version => ({ version, at, by: 'ferret', change: 'edited', lifecycle: 'active' })),
} as AgendaVersionList;
const versions: AgendaVersionsView = {
  list,
  load: async version => agendaItem('A5', { subject: 'Queue', whereWeAre: version === 1 ? 'old state' : 'new state' }),
};
const merge: AgendaMergeView = { candidates: [agendaItem('A2')], merge: async () => undefined };

const draw = async (
  extra: Partial<AgendaItem>,
  props: { versions?: AgendaVersionsView; merge?: AgendaMergeView } = {},
) => {
  view = await mount(
    <AgendaItemCard
      busy={false}
      error={null}
      ferret="kai"
      item={agendaItem('A5', { subject: 'Queue', ...extra })}
      now={NOW}
      onAct={() => undefined}
      renderProse={agendaProse()}
      swipeable={false}
      {...props}
    />,
  );
  return view.container;
};

describe('the item head’s version slot and lineage', () => {
  test('shows no diff control on a machine without versions', async () => {
    const root = await draw({});
    expect(root.querySelector('[data-agenda-diff-toggle]')).toBeNull();
    expect(root.querySelector('[data-agenda-lineage]')).toBeNull();
  });

  test('opens the changes under the head from the slot, and closes them again', async () => {
    const root = await draw({}, { versions });
    const slot = must(root.querySelector('[data-agenda-version-slot]'), 'slot');
    const toggle = must(slot.querySelector<HTMLElement>('[data-agenda-diff-toggle]'), 'toggle');
    expect(root.querySelector('[data-agenda-diff]')).toBeNull();
    await interact(() => toggle.click());
    await settleUntil(
      () => root.querySelector('[data-agenda-diff-section="whereWeAre"]') !== null,
      'the diff',
      interact,
    );
    expect(root.querySelector('[data-agenda-diff-section="whereWeAre"]')?.textContent).toContain('new');
    await interact(() => toggle.click());
    expect(root.querySelector('[data-agenda-diff]')).toBeNull();
  });

  test('offers Merge with… and says where a split came from, both from the card', async () => {
    const root = await draw({ splitFrom: 'A3' } as never, { merge });
    expect(root.querySelector('[data-agenda-merge-open]')).not.toBeNull();
    expect(root.querySelector('[data-agenda-lineage-line="split-from"]')?.textContent).toContain('Split from !A3');
  });
});
