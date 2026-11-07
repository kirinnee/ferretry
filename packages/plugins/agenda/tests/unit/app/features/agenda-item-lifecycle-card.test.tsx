import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem, AgendaVersionList } from '@ferretry/core-asks/contract';
import { AgendaItemView } from '../../../../app/features/agenda/agenda-item-view.tsx';
import { agendaProse } from '../../../../app/features/agenda/agenda-prose.tsx';
import type { AgendaMergeView, AgendaVersionsView } from '../../../../app/features/agenda/use-item-lifecycle.ts';
import { agendaItem } from '../../../support/app/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { settleUntil } from '@ferretry/app/testing';

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
    <AgendaItemView
      busy={false}
      error={null}
      ferret="kai"
      history={[]}
      item={agendaItem('A5', { subject: 'Queue', ...extra })}
      now={NOW}
      onAct={() => undefined}
      onClose={() => undefined}
      position={{ index: 0, total: 1 }}
      renderProse={agendaProse()}
      swipeable={false}
      {...props}
    />,
  );
  return view.container;
};

/** Opens the head's ⋯ menu and returns it. */
const openMenu = async (root: HTMLElement): Promise<HTMLElement> => {
  await interact(() => must(root.querySelector<HTMLElement>('[data-agenda-menu-toggle]'), '⋯').click());
  return must(root.querySelector<HTMLElement>('[data-agenda-menu]'), 'the menu');
};

describe('the item head’s version slot and lineage', () => {
  test('shows no diff control on a machine without versions', async () => {
    const root = await draw({});
    await openMenu(root);
    expect(root.querySelector('[data-agenda-diff-toggle]')).toBeNull();
    expect(root.querySelector('[data-agenda-lineage]')).toBeNull();
  });

  test('opens the changes under the head from the ⋯ menu’s version slot, and closes them again', async () => {
    const root = await draw({}, { versions });
    const slot = must((await openMenu(root)).querySelector('[data-agenda-version-slot]'), 'slot');
    const toggle = must(slot.querySelector<HTMLElement>('[data-agenda-diff-toggle]'), 'toggle');
    expect(root.querySelector('[data-agenda-diff]')).toBeNull();
    await interact(() => toggle.click());
    // Changes closes the menu; the panel opens under the card's head.
    expect(root.querySelector('[data-agenda-menu]')).toBeNull();
    await settleUntil(
      () => root.querySelector('[data-agenda-diff-section="whereWeAre"]') !== null,
      'the diff',
      interact,
    );
    expect(root.querySelector('[data-agenda-diff-section="whereWeAre"]')?.textContent).toContain('new');
    const again = must((await openMenu(root)).querySelector<HTMLElement>('[data-agenda-diff-toggle]'), 'toggle');
    expect(again.textContent).toBe('Hide changes');
    expect(again.getAttribute('aria-expanded')).toBe('true');
    await interact(() => again.click());
    expect(root.querySelector('[data-agenda-diff]')).toBeNull();
  });

  test('offers Merge with… in the ⋯ menu, opening the picker on the card, and says where a split came from', async () => {
    const root = await draw({ splitFrom: 'A3' } as never, { merge });
    expect(root.querySelector('.fy-card [data-agenda-merge-open]')).toBeNull();
    expect(root.querySelector('[data-agenda-lineage-line="split-from"]')?.textContent).toContain('Split from !A3');
    const open = must((await openMenu(root)).querySelector<HTMLElement>('[data-agenda-merge-open]'), 'Merge with…');
    expect(open.textContent).toBe('Merge with…');
    await interact(() => open.click());
    expect(root.querySelector('[data-agenda-menu]')).toBeNull();
    expect(root.querySelector('.fy-card [data-agenda-merge-picker]')).not.toBeNull();
    await interact(() => must(root.querySelector<HTMLElement>('.fy-merge__quiet'), 'Cancel').click());
    expect(root.querySelector('[data-agenda-merge-picker]')).toBeNull();
  });

  test('offers no Merge with… on an earlier version, which only reads', async () => {
    const root = await draw(
      { revisions: [{ at, by: 'agent', changed: ['subject'], previous: { subject: 'Old' } }] } as never,
      { merge },
    );
    const picker = must(
      (await openMenu(root)).querySelector<HTMLSelectElement>('[data-agenda-version-picker]'),
      'picker',
    );
    await interact(() => {
      picker.value = '1';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect((await openMenu(root)).querySelector('[data-agenda-merge-open]')).toBeNull();
  });
});
