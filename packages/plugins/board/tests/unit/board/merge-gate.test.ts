import { describe, it } from 'bun:test';
import { type BoardProjectId, type Card, type LaneSet, type PrLink, PrLinkSchema } from '../../../contract/index.ts';
import should from 'should';
import { BoardIndex } from '../../../daemon/lib/board/index.ts';
import { mergeGateOf } from '../../../daemon/lib/board/merge-gate.ts';
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
const linking = (...prs: PrLink[]): Pick<Card, 'links'> => ({
  links: { prs, branch: null, commits: [], docs: [] },
});
const waitsOn = (id: string) => ({ dependsOn: [{ task: { id: id as Card['id'] }, until: 'shipped' as const }] });
const gate = (cards: readonly Card[], unreadable: readonly string[] = []) =>
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
    should(answer?.waits).eql([{ card: { id: 'F20' }, on: { id: 'F18' }, until: 'shipped' }]);
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
    should(answer?.waits).eql([{ card: { id: 'F5' }, on: { id: 'F9' }, until: 'shipped' }]);
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

  it('should keep a finished card in the unit, and leave a dropped one out', () => {
    // Arrange — a sub-card closes itself when its ferret finishes, while its lead's PR is still open.
    const cards = [
      card({ id: 'F18' }),
      card({ id: 'F1', ...linking(prLink(42)) }),
      card({ id: 'F2', parent: { id: 'F1' }, laneId: 'closed', ...waitsOn('F18') }),
      card({ id: 'F21', dropped: { reason: 'gone', at: NOW }, ...linking(prLink(42)), ...waitsOn('F18') }),
    ];

    // Act
    const answer = gate(cards);

    // Assert
    should(answer?.unit).eql([{ id: 'F1' }, { id: 'F2' }]);
    should(answer?.waits).eql([{ card: { id: 'F2' }, on: { id: 'F18' }, until: 'shipped' }]);
  });

  it("should hold every child PR on an umbrella lead's wait: the lead's area merges in them", () => {
    const cards = [
      card({ id: 'F18' }),
      card({ id: 'F1', ...waitsOn('F18') }),
      card({ id: 'F2', parent: { id: 'F1' }, ...linking(prLink(42)) }),
    ];
    should(gate(cards)?.waits).eql([{ card: { id: 'F1' }, on: { id: 'F18' }, until: 'shipped' }]);
  });

  it('should keep the wait on a card of another machine that shares an id with a card in the unit', () => {
    // Arrange
    const cards = [
      card({
        id: 'F1',
        ...linking(prLink(42)),
        dependsOn: [{ task: { id: 'F1', machineId: 'machine-2' }, until: 'released' }],
      }),
    ];

    // Act
    const answer = gate(cards);

    // Assert
    should(answer?.waits).eql([{ card: { id: 'F1' }, on: { id: 'F1', machineId: 'machine-2' }, until: 'released' }]);
  });

  for (const order of ['F1 first', 'F2 first'] as const) {
    it(`should count a helper of a card that shares its unit through another PR (${order})`, () => {
      // Arrange — F1 links 42; F2 links 42 and 43 (one unit); F3 is F2's PR-free helper, waiting on F9.
      const f1 = card({ id: 'F1', ...linking(prLink(42)) });
      const f2 = card({ id: 'F2', ...linking(prLink(42), prLink(43)) });
      const rest = [
        card({ id: 'F9', laneId: 'implement' }),
        card({ id: 'F3', parent: { id: 'F2' }, ...waitsOn('F9') }),
      ];
      const cards = order === 'F1 first' ? [f1, f2, ...rest] : [f2, f1, ...rest];

      // Act
      const answer = mergeGateOf('https://github.com/kirinnee/ferretry/pull/43', {
        index: new BoardIndex(cards, MACHINE),
        laneSets,
        unreadable: [],
      });

      // Assert
      should(answer?.waits).eql([{ card: { id: 'F3' }, on: { id: 'F9' }, until: 'shipped' }]);
    });
  }

  describe('the live clash order', () => {
    const at = (minute: number): string => `2026-10-30T10:${String(minute).padStart(2, '0')}:00.000Z`;
    /** A card claiming each path at its minute, in that order. */
    const claiming = (id: string, claims: readonly (readonly [string, number])[], rest: Partial<Card> = {}) =>
      card({
        id: id as Card['id'],
        files: claims.map(([path]) => path),
        history: [
          { seq: 1, at: at(0), actor: { kind: 'ferret', ferret: 'lead' }, type: 'created', laneId: 'todo' },
          ...claims.map(([path, minute], n) => ({
            seq: n + 2,
            at: at(minute),
            actor: { kind: 'ferret' as const, ferret: 'lead' },
            type: 'file-claimed' as const,
            path,
          })),
        ],
        ...rest,
      });
    const gateFor = (number: number, cards: readonly Card[]) =>
      mergeGateOf(`https://github.com/kirinnee/ferretry/pull/${String(number)}`, {
        index: new BoardIndex(cards, MACHINE),
        laneSets,
        unreadable: [],
      });

    it('should queue siblings that claimed before either had a PR, in claim order', () => {
      // Arrange — F2 and F3 sat under PR-free F1 when they claimed x.ts (F2 first); each opened its own PR later.
      const cards = [
        card({ id: 'F1' }),
        claiming('F2', [['x.ts', 1]], { parent: { id: 'F1' }, ...linking(prLink(42)) }),
        claiming('F3', [['x.ts', 2]], { parent: { id: 'F1' }, ...linking(prLink(43)) }),
      ];

      // Act / Assert
      should(gateFor(43, cards)?.waits).eql([{ card: { id: 'F3' }, on: { id: 'F2' }, until: 'shipped' }]);
      should(gateFor(42, cards)?.waits).eql([]);
    });

    it("should never hold two PRs on each other through an umbrella lead's claims", () => {
      // Arrange — PR-free F1 claimed x.ts first; its child F2 (PR 42) claimed z.ts last; F3 (PR 43) claimed z.ts, then x.ts.
      const cards = [
        claiming('F1', [['x.ts', 1]], { laneId: 'implement' }),
        claiming('F2', [['z.ts', 4]], { parent: { id: 'F1' }, ...linking(prLink(42)) }),
        claiming(
          'F3',
          [
            ['z.ts', 2],
            ['x.ts', 3],
          ],
          linking(prLink(43)),
        ),
      ];

      // Act
      const forty2 = gateFor(42, cards)?.waits ?? [];
      const forty3 = gateFor(43, cards)?.waits ?? [];

      // Assert — exactly one of them waits, on the other.
      should(forty2).eql([]);
      should(forty3).eql([{ card: { id: 'F3' }, on: { id: 'F2' }, until: 'shipped' }]);
    });

    it("should not weigh the daemon's stale claim-time dependency", () => {
      // Arrange — F3 was queued behind F1 when it claimed, but F1 no longer claims anything that clashes.
      const f3 = claiming('F3', [['x.ts', 2]], { ...linking(prLink(43)), ...waitsOn('F1') });
      const stale = {
        ...f3,
        history: [
          ...f3.history,
          {
            seq: 3,
            at: at(2),
            actor: { kind: 'daemon' as const, ferret: 'lead' },
            type: 'depended' as const,
            task: { id: 'F1' as Card['id'] },
            until: 'shipped' as const,
          },
        ],
      };

      // Act / Assert
      should(gateFor(43, [card({ id: 'F1', laneId: 'implement' }), stale])?.waits).eql([]);
    });

    it('should let a lead waive a wait by removing it on purpose', () => {
      // Arrange
      const f3 = claiming('F3', [['x.ts', 2]], linking(prLink(43)));
      const waiving = {
        ...f3,
        history: [
          ...f3.history,
          {
            seq: 3,
            at: at(3),
            actor: { kind: 'ferret' as const, ferret: 'lead' },
            type: 'undepended' as const,
            task: { id: 'F2' as Card['id'] },
            reason: 'F3 goes first',
          },
        ],
      };

      // Act / Assert
      should(gateFor(43, [claiming('F2', [['x.ts', 1]], linking(prLink(42))), waiving])?.waits).eql([]);
    });

    it('should keep an older claim old when the same path is claimed again in another spelling', () => {
      // Arrange — F1 claimed x.ts first, then also ./x.ts after F2 claimed x.ts.
      const cards = [
        claiming(
          'F1',
          [
            ['x.ts', 1],
            ['./x.ts', 3],
          ],
          linking(prLink(42)),
        ),
        claiming('F2', [['x.ts', 2]], linking(prLink(43))),
      ];

      // Act / Assert
      should(gateFor(42, cards)?.waits).eql([]);
      should(gateFor(43, cards)?.waits).eql([{ card: { id: 'F2' }, on: { id: 'F1' }, until: 'shipped' }]);
    });

    it('should never circle three PRs through an umbrella and a tied claim', () => {
      // Arrange — PR-free F9 claimed at minute 1; its children F1 (PR 42) at 3 and F3 (PR 43) at 2; F2 (PR 44) at 1.
      const cards = [
        claiming('F9', [['x.ts', 1]], { laneId: 'implement' }),
        claiming('F1', [['x.ts', 3]], { parent: { id: 'F9' }, ...linking(prLink(42)) }),
        claiming('F3', [['x.ts', 2]], { parent: { id: 'F9' }, ...linking(prLink(43)) }),
        claiming('F2', [['x.ts', 1]], linking(prLink(44))),
      ];

      // Act
      const waiting = [42, 43, 44].filter(number => (gateFor(number, cards)?.waits.length ?? 0) > 0);

      // Assert — the earliest of them is free, so the queue always moves.
      should(waiting.length).be.below(3);
      should(gateFor(44, cards)?.waits).eql([]);
    });

    for (const child of ['dropped', 'shipped'] as const) {
      it(`should hold a PR on an umbrella lead whose only child unit was ${child}`, () => {
        // Arrange — PR-free F1 claimed x.ts first; its only child F2 has a PR but was dropped, or already shipped.
        const f2 =
          child === 'dropped'
            ? card({ id: 'F2', parent: { id: 'F1' }, dropped: { reason: 'gone', at: NOW }, ...linking(prLink(42)) })
            : card({ id: 'F2', parent: { id: 'F1' }, laneId: 'merged', ...linking(prLink(42)) });
        const cards = [
          claiming('F1', [['x.ts', 1]], { laneId: 'implement' }),
          f2,
          claiming('F3', [['x.ts', 2]], linking(prLink(43))),
        ];

        // Act / Assert
        should(gateFor(43, cards)?.waits).eql([{ card: { id: 'F3' }, on: { id: 'F1' }, until: 'shipped' }]);
      });
    }

    it("should keep an umbrella lead's claim on a live grandchild's PR when the child between them was dropped", () => {
      // Arrange — F9 (PR 43) claimed x.ts first; PR-free F1 claimed it next; F2 under F1 was dropped; F3 under F2 ships PR 42.
      const cards = [
        claiming('F9', [['x.ts', 1]], linking(prLink(43))),
        claiming('F1', [['x.ts', 2]], { laneId: 'implement' }),
        card({ id: 'F2', parent: { id: 'F1' }, dropped: { reason: 'gone', at: NOW } }),
        claiming('F3', [['z.ts', 3]], { parent: { id: 'F2' }, ...linking(prLink(42)) }),
      ];

      // Act / Assert
      should(gateFor(42, cards)?.waits).eql([{ card: { id: 'F1' }, on: { id: 'F9' }, until: 'shipped' }]);
    });

    it('should not hold a PR on a unit that already shipped', () => {
      const cards = [
        claiming('F2', [['x.ts', 1]], { laneId: 'merged', ...linking(prLink(42)) }),
        claiming('F3', [['x.ts', 2]], linking(prLink(43))),
      ];
      should(gateFor(43, cards)?.waits).eql([]);
    });
  });

  it('should name the cards it could not read', () => {
    should(gate([], ['F7'])?.unreadable).eql(['F7']);
  });

  it('should answer null for something that is not a PR URL', () => {
    should(mergeGateOf('F12', { index: new BoardIndex([], MACHINE), laneSets, unreadable: [] })).be.null();
  });
});
