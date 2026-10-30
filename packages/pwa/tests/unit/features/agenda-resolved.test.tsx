import { afterEach, describe, expect, test } from 'bun:test';
import type { ResolvedAgendaItem } from '@ferretry/protocol';
import { byNewestResolution, ResolvedRow, resolvedWhen } from '../../../src/features/agenda/agenda-resolved.tsx';
import '../../support/dom.ts';
import { type Mounted, mount, must } from '../../support/dom.ts';

const record = (
  id: string,
  resolvedAt: string,
  overrides: Partial<Record<keyof ResolvedAgendaItem, unknown>> = {},
): ResolvedAgendaItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}`,
    why: 'Why.',
    waitingSince: '2026-07-31T09:00:00.000Z',
    howToResolve: 'Answer it.',
    ask: { kind: 'permission' },
    raisedBy: 'agent',
    raisedBySession: 'shared',
    raisedByName: 'zoe',
    resolvedAt,
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    resolutionNote: null,
    disposition: 'resolved',
    response: { kind: 'permission', decision: 'approve' },
    ...overrides,
  }) as ResolvedAgendaItem;

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('the resolved records', () => {
  test('sort the newest resolution first', () => {
    const older = record('A1', '2026-07-31T10:00:00.000Z');
    const newer = record('A2', '2026-07-31T11:00:00.000Z');
    expect([older, newer].sort(byNewestResolution).map(r => r.id)).toEqual(['A2', 'A1']);
  });

  test('the time reads short, without a year or seconds', () => {
    const stamp = resolvedWhen('2026-10-23T08:54:30.000Z', 'UTC');
    expect(stamp).toContain('Oct');
    expect(stamp).toContain('23');
    expect(stamp).not.toContain('2026');
    expect(stamp).not.toMatch(/:\d\d:\d\d/);
  });

  test('an open-question answer reads as its own words, never "undefined"', async () => {
    view = await mount(
      <ul>
        <ResolvedRow
          id="attn-A1"
          record={record('A1', '2026-07-31T10:00:00.000Z', {
            response: { kind: 'open-question', answer: 'The team login.' },
          })}
        />
      </ul>,
    );
    const text = must(view.container, 'view').textContent ?? '';
    expect(text).toContain('Answered: The team login.');
    expect(text).not.toContain('undefined');
  });

  test('a row says how it was cleared, with the note, and rings the linked one', async () => {
    view = await mount(
      <ul>
        <ResolvedRow
          highlighted
          id="attn-A2"
          record={record('A2', '2026-07-31T11:00:00.000Z', {
            disposition: 'dismissed',
            response: null,
            resolutionNote: 'Superseded by A3.',
          })}
        />
      </ul>,
    );
    const row = must(must(view.container, 'view').querySelector('[data-agenda-record="A2"]'), 'the A2 row');
    expect(row.textContent).toContain('dismissed by you');
    expect(row.textContent).toContain('Superseded by A3.');
    expect(row.getAttribute('data-highlighted')).toBe('true');
  });
});
