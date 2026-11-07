import { describe, it } from 'bun:test';
import type { FerretState, FerretSummary, SitrepLine } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import should from 'should';
import { PACK_ENDED_WINDOW_MS, PackTableSchema } from '../../../contract/index.ts';
import { buildPackTable, oneLine, packMembers, packRowState } from '../../../daemon/lib/table.ts';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const at = (minutesAgo: number): Instant => new Date(NOW - minutesAgo * 60_000).toISOString() as Instant;

const ferret = (
  id: string,
  extra: Partial<Omit<FerretSummary, 'id'>> & { readonly state?: FerretState } = {},
): FerretSummary => ({
  id: id as FerretSummary['id'],
  name: id,
  role: 'helper',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/work',
  state: 'working',
  createdAt: at(300),
  stateAt: at(1),
  ...extra,
});

const ROOT = ferret('lead', { role: 'lead' });
const build = (
  ferrets: readonly FerretSummary[],
  lines: Readonly<Record<string, readonly SitrepLine[]>> = {},
  blockers: Readonly<Record<string, number>> = {},
) =>
  buildPackTable({
    root: ROOT,
    ferrets,
    lines: id => lines[id] ?? [],
    blockers: id => blockers[id] ?? 0,
    nowMs: NOW,
  });

describe('oneLine', () => {
  it('should take the first non-blank line, collapse whitespace and cut with an ellipsis', () => {
    should(oneLine('\n  hello   there \nsecond')).equal('hello there');
    should(oneLine('x'.repeat(150)).length).equal(100);
    should(oneLine('x'.repeat(150)).endsWith('…')).be.true();
    should(oneLine('   ')).equal('');
  });
});

describe('packRowState', () => {
  it('should say running, waiting, needs-you or ended', () => {
    should(packRowState('starting', 0)).equal('running');
    should(packRowState('working', 3)).equal('running');
    should(packRowState('idle', 0)).equal('waiting');
    should(packRowState('idle', 2)).equal('needs-you');
    should(packRowState('stopped', 2)).equal('ended');
  });
});

describe('packMembers', () => {
  it('should list helpers in tree order, depth from the root, and not the root or other leads’ helpers', () => {
    // Arrange
    const ferrets = [
      ferret('b', { parent: 'lead' as FerretSummary['id'], name: 'Beta' }),
      ferret('a', { parent: 'lead' as FerretSummary['id'], name: 'Alpha' }),
      ferret('a2', { parent: 'a' as FerretSummary['id'], name: 'Alpha child' }),
      ferret('x', { parent: 'other' as FerretSummary['id'] }),
    ];

    // Act
    const members = packMembers(ferrets, 'lead', NOW);

    // Assert
    should(members.map(member => [member.ferret.id, member.depth])).deepEqual([
      ['a', 1],
      ['a2', 2],
      ['b', 1],
    ]);
  });

  it('should keep an ended ferret only while it ended inside the window, and still list its live helper', () => {
    // Arrange
    const ferrets = [
      ferret('recent', { parent: 'lead' as FerretSummary['id'], state: 'stopped', stateAt: at(10) }),
      ferret('old', {
        parent: 'lead' as FerretSummary['id'],
        state: 'stopped',
        stateAt: at(PACK_ENDED_WINDOW_MS / 60_000 + 5),
      }),
      ferret('orphan', { parent: 'old' as FerretSummary['id'] }),
    ];

    // Act
    const ids = packMembers(ferrets, 'lead', NOW).map(member => member.ferret.id);

    // Assert
    should(ids).deepEqual(['orphan', 'recent']);
  });

  it('should terminate on a parent cycle', () => {
    const ferrets = [
      ferret('a', { parent: 'b' as FerretSummary['id'] }),
      ferret('b', { parent: 'a' as FerretSummary['id'] }),
      ferret('c', { parent: 'lead' as FerretSummary['id'] }),
    ];
    should(packMembers(ferrets, 'lead', NOW).map(member => member.ferret.id)).deepEqual(['c']);
  });
});

describe('buildPackTable', () => {
  it('should build rows a reader can parse: state, card, newest line and when it ended', () => {
    // Arrange
    const ferrets = [
      ferret('w', { parent: 'lead' as FerretSummary['id'], runtime: 'claude-main' as FerretSummary['runtime'] }),
      ferret('i', { parent: 'lead' as FerretSummary['id'], state: 'idle' }),
      ferret('e', { parent: 'lead' as FerretSummary['id'], state: 'stopped', stateAt: at(5) }),
    ];
    const lines = {
      w: [
        { kind: 'card', text: 'Fix the bug', ref: '&F7' },
        { kind: 'doing', text: 'running tests\nsecond line', at: at(3) },
        { kind: 'note', text: 'halfway', at: at(3) },
      ] satisfies SitrepLine[],
    };

    // Act
    const table = build(ferrets, lines, { i: 1 });

    // Assert
    should(PackTableSchema.safeParse(table).success).be.true();
    should(table.root).deepEqual({ id: 'lead', name: 'lead' });
    should(table.at).equal(new Date(NOW).toISOString());
    const [e, i, w] = table.rows;
    should(w).containEql({ id: 'w', model: 'claude-main', state: 'running', depth: 1, card: { ref: '&F7' } });
    should(w?.last).deepEqual({ at: at(3), source: 'note', text: 'halfway' });
    should(i?.state).equal('needs-you');
    should(i?.model).equal('claude-code');
    should(e).containEql({ state: 'ended', endedAt: at(5), ferretState: 'stopped' });
  });

  it('should be an empty table for a lead with no helpers', () => {
    should(build([]).rows).deepEqual([]);
  });
});
