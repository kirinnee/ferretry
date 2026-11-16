import { expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import type { SubtreeView } from '../../../../contract/index.ts';
import { prCell, renderSubtreeTable } from '../../../../cli/lib/session/subtree-table.ts';
import { ferretId } from '../../../../contract/testing/index.ts';

const NOW = Date.parse('2026-11-06T09:00:00.000Z');

const view = (rows: SubtreeView['rows']): SubtreeView => ({
  root: { id: ferretId('lead'), name: 'rhett' },
  at: '2026-11-06T09:00:00.000Z' as Instant,
  endedWindowMs: 7_200_000,
  rows,
});

test('a lead reads the model, the card with its lane and the PR of each helper, as today’s table showed them', () => {
  const lines = renderSubtreeTable(
    view([
      {
        id: ferretId('ada'),
        name: 'ada',
        depth: 1,
        model: 'sonnet-5-5',
        state: 'running',
        ferretState: 'working',
        card: { ref: '&F767', lane: 'Implement' },
        pr: { number: 321, url: 'https://github.com/o/r/pull/321', state: 'open', draft: false, checks: 'pending' },
        last: { at: '2026-11-06T08:58:00.000Z', kind: 'note', text: 'route and table done' },
      },
      { id: ferretId('bo'), name: 'bo', depth: 2, model: 'glm-5.3', state: 'waiting', ferretState: 'idle' },
    ]),
    NOW,
  );
  expect(lines[1]).toMatch(/^FERRET\s+MODEL\s+STATE\s+CARD\s+PR\s+LAST$/u);
  expect(lines[2]).toMatch(
    /^ada\s+sonnet-5-5\s+running\s+&F767 Implement\s+#321 CI pending\s+\[2m\] route and table done$/u,
  );
  expect(lines[3]).toMatch(/^ {2}bo\s+glm-5\.3\s+waiting\s+-\s+-\s+-$/u);
});

test('a PR shows CI while it is live and its state once it is not', () => {
  const base = { url: 'https://github.com/o/r/pull/7', draft: false, checks: 'failing' } as const;
  expect(prCell({ ...base, number: 7, state: 'open' })).toBe('#7 CI failing');
  expect(prCell({ ...base, number: 7, state: 'open', draft: true })).toBe('#7 draft CI failing');
  expect(prCell({ ...base, number: 7, state: 'merged' })).toBe('#7 merged');
  expect(prCell(undefined)).toBe('-');
});
