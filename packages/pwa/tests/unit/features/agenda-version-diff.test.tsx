import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem, AgendaVersionList } from '@ferretry/protocol';
import { DiffToggle, VersionDiffPanel } from '../../../src/features/agenda/agenda-version-diff.tsx';
import type { AgendaVersionsView } from '../../../src/features/agenda/use-item-lifecycle.ts';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { settleUntil } from '../../support/settle.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const NOW = Date.parse('2026-11-01T12:00:00.000Z');

const v1 = agendaItem('A5', {
  subject: 'Queue choice',
  whereWeAre: 'We are comparing two queues.',
  ask: { kind: 'multiple-choice', options: [{ label: 'Redis' }, { label: 'Postgres' }] },
} as Partial<AgendaItem>);
const v2 = agendaItem('A5', {
  subject: 'Queue choice',
  whereWeAre: 'We chose Postgres and the migration is written.',
  terms: [{ term: 'Outbox', meaning: 'Writes jobs in the same transaction' }],
  ask: { kind: 'multiple-choice', options: [{ label: 'Ship it' }, { label: 'Wait' }] },
} as Partial<AgendaItem>);
const v3 = { ...v2, whereWeAre: 'We chose Postgres, the migration is written and tested.' } as AgendaItem;
const items: Readonly<Record<number, AgendaItem>> = { 1: v1, 2: v2, 3: v3 };

const summary = (version: number, change: string) => ({
  version,
  at: new Date(NOW - (4 - version) * 3_600_000).toISOString(),
  by: 'ferret' as const,
  change,
  lifecycle: 'active' as const,
});

const listOf = (latest: number, seen?: number): AgendaVersionList =>
  ({
    sessionId: 's',
    id: 'A5',
    latest,
    ...(seen === undefined ? {} : { seen }),
    versions: [summary(1, 'created'), summary(2, 'edited'), summary(3, 'edited')].slice(0, latest),
  }) as AgendaVersionList;

const viewOf = (list: AgendaVersionList, loads: number[] = [], fail = false): AgendaVersionsView => ({
  list,
  load: async version => {
    loads.push(version);
    if (fail) throw new Error('gone');
    return items[version] as AgendaItem;
  },
});

const draw = async (versions: AgendaVersionsView): Promise<HTMLElement> => {
  view = await mount(<VersionDiffPanel id="diff" now={NOW} versions={versions} />);
  const root = view.container;
  await settleUntil(
    () => root.querySelector('[data-agenda-diff-summary], [role="alert"]') !== null,
    'the diff',
    interact,
  );
  return root;
};

describe('the Changes button', () => {
  test('says whether the comparison is open and toggles it', async () => {
    let toggled = 0;
    view = await mount(<DiffToggle controls="diff" onToggle={() => (toggled += 1)} open={false} />);
    const button = must(view.container.querySelector<HTMLElement>('[data-agenda-diff-toggle]'), 'toggle');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('diff');
    expect(button.textContent).toContain('Changes');
    await interact(() => button.click());
    expect(toggled).toBe(1);
  });
});

describe('the comparison', () => {
  test('defaults to what changed since this device last looked, and reads both versions once', async () => {
    const loads: number[] = [];
    const root = await draw(viewOf(listOf(3, 2), loads));
    expect(root.querySelector('[data-agenda-diff-basis]')?.textContent).toContain('Since you last looked');
    expect(root.querySelector('[data-agenda-diff-basis]')?.textContent).toContain('v2 to v3');
    expect(loads.sort()).toEqual([2, 3]);
    const changed = [...root.querySelectorAll('[data-agenda-diff-section]')].map(each =>
      each.getAttribute('data-agenda-diff-section'),
    );
    expect(changed).toEqual(['whereWeAre']);
    expect(root.querySelector('[data-agenda-diff-summary]')?.textContent).toContain('1 section changed');
  });

  test('marks additions and removals with words, signs and line styles, never colour alone', async () => {
    const root = await draw(viewOf(listOf(3, 1)));
    const where = must(root.querySelector('[data-agenda-diff-section="whereWeAre"]'), 'where we are');
    expect(where.getAttribute('data-status')).toBe('changed');
    expect(where.querySelector('.fy-diff__status')?.textContent).toBe('Changed');
    expect(where.querySelector('ins')).not.toBeNull();
    expect(where.querySelector('del')).not.toBeNull();
    expect(where.querySelector('.fy-diff__count')?.textContent).toMatch(/\+\d+.*−\d+/u);
    const terms = must(root.querySelector('[data-agenda-diff-section="terms"]'), 'terms');
    expect(terms.querySelector('.fy-diff__status')?.textContent).toBe('New');
    expect(root.querySelector('.fy-diff__legend')?.textContent).toContain('Underlined');
  });

  test('keeps a struck word apart from the word that replaces it', async () => {
    const root = await draw(viewOf(listOf(3, 1)));
    const where = must(root.querySelector('[data-agenda-diff-section="whereWeAre"]'), 'where we are');
    const pairs = [...where.querySelectorAll('del')].filter(del => del.nextElementSibling?.tagName === 'INS');
    expect(pairs.length).toBeGreaterThan(0);
    for (const del of pairs) expect(del.nextSibling?.nodeType).toBe(Node.TEXT_NODE);
  });

  test('folds the sections that did not change under one line', async () => {
    const root = await draw(viewOf(listOf(3, 2)));
    const folded = must(root.querySelector('[data-agenda-diff-unchanged]'), 'unchanged fold');
    expect(folded.querySelector('summary')?.textContent).toMatch(/sections? unchanged/u);
    expect(root.querySelector('[data-agenda-diff-section="ask"]')).toBeNull();
  });

  test('lets the owner pick any two versions, in whichever order', async () => {
    const root = await draw(viewOf(listOf(3, 2)));
    const from = must(root.querySelector<HTMLSelectElement>('[data-agenda-diff-from]'), 'from');
    await interact(() => {
      from.value = '1';
      from.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settleUntil(
      () => root.querySelector('[data-agenda-diff-section="ask"]') !== null,
      'the wider diff',
      interact,
    );
    expect(root.querySelector('[data-agenda-diff-basis]')?.textContent).toBe('v1 to v3');
    const to = must(root.querySelector<HTMLSelectElement>('[data-agenda-diff-to]'), 'to');
    await interact(() => {
      to.value = '1';
      to.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settleUntil(
      () => root.querySelector('[data-agenda-diff-summary]')?.textContent?.includes('Pick two different') === true,
      'the same-version note',
      interact,
    );
    expect(root.querySelector('[data-agenda-diff-basis]')?.textContent).toBe('v1 to v1');
  });

  test('returns to the default when the owner picks the default pair again', async () => {
    const root = await draw(viewOf(listOf(3, 2)));
    const from = must(root.querySelector<HTMLSelectElement>('[data-agenda-diff-from]'), 'from');
    await interact(() => {
      from.value = '1';
      from.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await interact(() => {
      from.value = '2';
      from.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settleUntil(
      () => root.querySelector('[data-agenda-diff-basis]')?.textContent?.includes('Since you last looked') === true,
      'the default again',
      interact,
    );
  });

  test('compares from the start when the device never looked, and from the one before when it is up to date', async () => {
    const never = await draw(viewOf(listOf(3)));
    expect(never.querySelector('[data-agenda-diff-basis]')?.textContent).toContain('v1 to v3');
    await view?.unmount();
    const upToDate = await draw(viewOf(listOf(3, 3)));
    expect(upToDate.querySelector('[data-agenda-diff-basis]')?.textContent).toContain('v2 to v3');
  });

  test('says so when a version cannot be read', async () => {
    const root = await draw(viewOf(listOf(3, 2), [], true));
    expect(must(root.querySelector('[role="alert"]'), 'alert').textContent).toContain('could not be read');
  });

  test('says there is nothing to compare when no section differs', async () => {
    const same = { ...viewOf(listOf(3, 2)), load: async () => v1 };
    const root = await draw(same);
    expect(root.querySelector('[data-agenda-diff-section]')).toBeNull();
    expect(root.querySelector('[data-agenda-diff-summary]')?.textContent).toBeTruthy();
  });
});
