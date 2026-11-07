import { describe, it } from 'bun:test';
import { type SubtreeRow, type SubtreeView, SubtreeViewSchema } from '@ferretry/protocol';
import should from 'should';
import type { ICellColour } from '../../../src/lib/session/ports.ts';
import { prCell, renderSubtreeTable, sinceLabel } from '../../../src/lib/session/subtree-table.ts';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const markerColour: ICellColour = { amber: cell => `<amber>${cell}</amber>` };

const row = (overrides: Partial<SubtreeRow> & Pick<SubtreeRow, 'id' | 'callsign'>): SubtreeRow => ({
  depth: 1,
  model: 'sonnet',
  state: 'running',
  status: 'running',
  ...overrides,
});

const view = (rows: SubtreeRow[]): SubtreeView => ({
  root: { id: 'ses-lead', callsign: 'rhett' },
  at: '2026-11-03T12:00:00.000Z',
  endedWindowMs: 7_200_000,
  rows,
});

describe('sinceLabel', () => {
  it('should say now under a minute and the coarsest whole unit after', () => {
    should(sinceLabel(NOW, '2026-11-03T11:59:30.000Z')).equal('now');
    should(sinceLabel(NOW, '2026-11-03T11:55:00.000Z')).equal('5m');
    should(sinceLabel(NOW, '2026-11-03T09:00:00.000Z')).equal('3h');
    should(sinceLabel(NOW, '2026-11-01T12:00:00.000Z')).equal('2d');
  });

  it('should say now for an instant it cannot read', () => {
    should(sinceLabel(NOW, 'garbage')).equal('now');
  });
});

describe('prCell', () => {
  const base = { number: 42, url: 'https://example.test/pull/42', draft: false } as const;

  it('should show CI for an open PR, draft first', () => {
    should(prCell({ ...base, state: 'open', checks: 'passing' })).equal('#42 CI passing');
    should(prCell({ ...base, state: 'open', checks: 'pending', draft: true })).equal('#42 draft CI pending');
    should(prCell({ ...base, state: 'unknown', checks: 'none' })).equal('#42 CI none');
  });

  it('should show the state, not CI, once the PR is settled', () => {
    should(prCell({ ...base, state: 'merged', checks: 'passing' })).equal('#42 merged');
    should(prCell({ ...base, state: 'closed', checks: 'failing' })).equal('#42 closed');
  });

  it('should show a dash without a PR', () => {
    should(prCell(undefined)).equal('-');
  });
});

describe('renderSubtreeTable', () => {
  it('should render a header and one aligned line per row, indenting by depth', () => {
    // Arrange
    const subject = view([
      row({
        id: 'a',
        callsign: 'ada',
        card: { ref: '&F7', lane: 'Implement' },
        pr: { number: 9, url: 'u', state: 'open', draft: false, checks: 'failing' },
        last: { at: '2026-11-03T11:58:00.000Z', source: 'note', text: 'wiring the route' },
      }),
      row({ id: 'b', callsign: 'bo', depth: 2, model: 'glm-5.3' }),
    ]);

    // Act
    const lines = renderSubtreeTable(subject, NOW, markerColour);

    // Assert
    should(lines[0]).equal('rhett (ses-lead): 2 descendants');
    should(lines[1]).match(/^SESSION\s+MODEL\s+STATE\s+CARD\s+PR\s+LAST$/);
    should(lines[2]).match(/^ada\s+sonnet\s+running\s+&F7 Implement\s+#9 CI failing\s+\[2m\] wiring the route$/);
    should(lines[3]).match(/^ {2}bo\s+glm-5\.3\s+running\s+-\s+-\s+-$/);
  });

  it('should mark an ended row with how long ago it ended', () => {
    const lines = renderSubtreeTable(
      view([
        row({ id: 'a', callsign: 'ada', state: 'ended', status: 'completed', endedAt: '2026-11-03T11:50:00.000Z' }),
      ]),
      NOW,
      markerColour,
    );

    should(lines[2]).match(/ended 10m/);
  });

  it('should paint only the state cell of a row that needs the owner', () => {
    const lines = renderSubtreeTable(
      view([row({ id: 'a', callsign: 'ada', state: 'needs-you' }), row({ id: 'b', callsign: 'bo' })]),
      NOW,
      markerColour,
    );

    should(lines[2]).match(/<amber>needs-you<\/amber>/);
    should(lines[3]).not.match(/amber/);
  });

  it('should say so, and name the ended window, when there are no descendants', () => {
    should(renderSubtreeTable(view([]), NOW, markerColour)).deepEqual([
      'rhett (ses-lead): 0 descendants; ended ones show for 120m',
    ]);
  });

  it('should use the singular for one descendant', () => {
    should(renderSubtreeTable(view([row({ id: 'a', callsign: 'ada' })]), NOW, markerColour)[0]).match(/1 descendant$/);
  });
});

describe('SubtreeViewSchema (the --json shape)', () => {
  it('should accept the rows the table is built from and refuse an unknown field', () => {
    const subject = view([
      row({ id: 'a', callsign: 'ada', last: { at: '2026-11-03T11:58:00.000Z', source: 'message', text: 'done' } }),
    ]);

    should(SubtreeViewSchema.parse(subject)).deepEqual(subject);
    should(SubtreeViewSchema.safeParse({ ...subject, extra: 1 }).success).be.false();
  });

  it('should refuse a last line over 100 characters', () => {
    const long = view([
      row({
        id: 'a',
        callsign: 'ada',
        last: { at: '2026-11-03T11:58:00.000Z', source: 'note', text: 'x'.repeat(101) },
      }),
    ]);

    should(SubtreeViewSchema.safeParse(long).success).be.false();
  });
});
