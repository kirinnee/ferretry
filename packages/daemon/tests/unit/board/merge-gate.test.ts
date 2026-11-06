import { describe, it } from 'bun:test';
import { type BoardProjectId, type BoardTask, type LaneSet, type PrLink, PrLinkSchema } from '@ferretry/protocol';
import should from 'should';
import { BoardIndex } from '../../../src/lib/board/index.ts';
import { mergeGateOf } from '../../../src/lib/board/merge-gate.ts';
import { card, lanes, MACHINE, NOW, PROJECT } from './support.ts';

const PR = 'https://github.com/kirinnee/ferretry/pull/42';
const laneSets: ReadonlyMap<BoardProjectId, LaneSet> = new Map([[PROJECT as BoardProjectId, lanes()]]);

const prLink = (number: number, repo = 'kirinnee/ferretry'): PrLink =>
  PrLinkSchema.parse({
    url: `https://github.com/${repo}/pull/${String(number)}`,
    number,
    repo,
    state: 'open',
    draft: false,
    checks: 'passing',
    mergedAt: null,
    mergeSha: null,
    releasedIn: null,
    polledAt: NOW,
  });
const linking = (...prs: PrLink[]): Pick<BoardTask, 'links'> => ({
  links: { prs, branch: null, commits: [], docs: [] },
});
const waitsOn = (id: string) => ({ dependsOn: [{ task: { id: id as BoardTask['id'] }, until: 'shipped' as const }] });
const gate = (cards: readonly BoardTask[], unreadable: readonly string[] = []) =>
  mergeGateOf(PR, { index: new BoardIndex(cards, MACHINE), laneSets, unreadable });

describe('mergeGateOf', () => {
  it('should be free when no card links the PR', () => {
    should(gate([card()])).eql({ pr: PR, unit: [], waits: [], unreadable: [] });
  });

  it('should name the wait of a card linking the PR on a card not done yet', () => {
    // Arrange
    const cards = [
      card({ id: 'F18', laneId: 'implement' }),
      card({ id: 'F20', ...linking(prLink(42)), ...waitsOn('F18') }),
    ];

    // Act
    const answer = gate(cards);

    // Assert
    should(answer?.unit).eql([{ id: 'F20' }]);
    should(answer?.waits).eql([{ task: { id: 'F20' }, on: { id: 'F18' }, until: 'shipped' }]);
  });

  it('should match the PR whatever the case of its repository', () => {
    const cards = [
      card({ id: 'F18' }),
      card({ id: 'F20', ...linking(prLink(42, 'KirinNee/Ferretry')), ...waitsOn('F18') }),
    ];
    should(gate(cards)?.waits.length).equal(1);
  });

  it('should be free once the blocker ships', () => {
    const cards = [
      card({ id: 'F18', laneId: 'merged' }),
      card({ id: 'F20', ...linking(prLink(42)), ...waitsOn('F18') }),
    ];
    should(gate(cards)?.waits).eql([]);
  });

  it("should count a helper's wait: a sub-card with no PR ships in its lead's PR", () => {
    // Arrange
    const cards = [
      card({ id: 'F9' }),
      card({ id: 'F1', ...linking(prLink(42)) }),
      card({ id: 'F5', parent: { id: 'F1' }, ...waitsOn('F9') }),
      card({ id: 'F6', parent: { id: 'F1' }, ...linking(prLink(43)), ...waitsOn('F9') }),
    ];

    // Act
    const answer = gate(cards);

    // Assert — F6 ships in its own PR, so its wait is not this PR's.
    should(answer?.unit).eql([{ id: 'F1' }, { id: 'F5' }]);
    should(answer?.waits).eql([{ task: { id: 'F5' }, on: { id: 'F9' }, until: 'shipped' }]);
  });

  it('should never hold a PR on a card that ships in the same merge', () => {
    // Arrange — two cards linking one PR, one waiting on the other (the link arrived after the claim queued it).
    const cards = [
      card({ id: 'F1', ...linking(prLink(42)) }),
      card({ id: 'F2', ...linking(prLink(42), prLink(7)), ...waitsOn('F1') }),
      card({ id: 'F3', parent: { id: 'F1' }, ...waitsOn('F1') }),
    ];

    // Act
    const answer = gate(cards);

    // Assert
    should(answer?.waits).eql([]);
  });

  it('should leave closed and dropped cards linking the PR out of the unit', () => {
    const cards = [
      card({ id: 'F18' }),
      card({ id: 'F20', laneId: 'closed', ...linking(prLink(42)), ...waitsOn('F18') }),
      card({ id: 'F21', dropped: { reason: 'gone', at: NOW }, ...linking(prLink(42)), ...waitsOn('F18') }),
    ];
    should(gate(cards)).eql({ pr: PR, unit: [], waits: [], unreadable: [] });
  });

  it('should name the cards it could not read', () => {
    should(gate([], ['F7'])?.unreadable).eql(['F7']);
  });

  it('should answer null for something that is not a PR URL', () => {
    should(mergeGateOf('F12', { index: new BoardIndex([], MACHINE), laneSets, unreadable: [] })).be.null();
  });
});
