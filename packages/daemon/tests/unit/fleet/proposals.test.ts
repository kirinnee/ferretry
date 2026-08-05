import { describe, it } from 'bun:test';
import should from 'should';
import type { FleetMutation } from '../../../src/lib/fleet/mutations.ts';
import { FLEET_APPROVAL_MAX_ATTEMPTS, FLEET_APPROVAL_TTL_SECONDS } from '@ferretry/protocol';
import {
  type FleetProposalProblem,
  FleetProposalRefusal,
  FleetProposalStore,
  MAX_OPEN_PROPOSALS,
  normalizeApprovalCode,
  PROPOSAL_TTL_SECONDS,
  redactProposal,
} from '../../../src/lib/fleet/proposals.ts';

const INITIALIZE: FleetMutation = { kind: 'initialize' };

interface Clock {
  value: number;
}

function storeOf(options: { readonly ids?: readonly string[]; readonly code?: string } = {}): {
  store: FleetProposalStore<string>;
  clock: Clock;
} {
  const clock: Clock = { value: 1_000_000 };
  let index = 0;
  const ids = options.ids ?? [];
  return {
    clock,
    store: new FleetProposalStore<string>({
      now: () => clock.value,
      mintId: () => ids[index++] ?? `mint${String(index).padStart(18, '0')}`,
      mintCode: () => options.code ?? 'AAAA-BBBB',
    }),
  };
}

const open = (store: FleetProposalStore<string>, summary = 'a change') =>
  store.open({
    revision: 'rev',
    mutation: INITIALIZE,
    assetEdits: [],
    assetRevisions: [],
    payload: 'artifact',
    summary,
  });

const problemOf = (act: () => unknown): FleetProposalProblem => {
  try {
    act();
  } catch (error) {
    should(error).be.instanceof(FleetProposalRefusal);
    return (error as FleetProposalRefusal).problem;
  }
  throw new Error('expected a refusal');
};

describe('normalizeApprovalCode', () => {
  it.each([['aaaa-bbbb'], ['AAAA BBBB'], ['aaaabbbb'], ['  AAAA-bbbb  ']])(
    'should read %j the way a person types it',
    typed => {
      // Act + Assert
      should(normalizeApprovalCode(typed)).equal('AAAA-BBBB');
    },
  );
});

describe('FleetProposalStore', () => {
  it('should mint a handle a caller could not have guessed or chosen', () => {
    // Arrange
    const { store } = storeOf({ ids: ['7Zq3Kd91Lm4Rt8Vx2Ns6Bc'] });

    // Act
    const actual = open(store);

    // Assert
    should(actual.id).equal('fy_fprop_7Zq3Kd91Lm4Rt8Vx2Ns6Bc');
  });

  it('should refuse a handle that would replace a proposal already held', () => {
    // Arrange — a repeated identifier must never silently overwrite somebody else's change. The
    // source here is stuck, so every retry returns the handle already held.
    const { store } = storeOf({ ids: Array.from({ length: 8 }, () => '7Zq3Kd91Lm4Rt8Vx2Ns6Bc') });
    const first = open(store);

    // Act
    const actual = problemOf(() => open(store));

    // Assert
    should(actual).equal('exhausted');
    should(store.require(first.id).summary).equal('a change');
  });

  it('should report a change that timed out as expired rather than as one that never existed', () => {
    // Arrange
    const { store, clock } = storeOf();
    const proposal = open(store);

    // Act
    clock.value += PROPOSAL_TTL_SECONDS * 1000;
    const actual = problemOf(() => store.require(proposal.id));

    // Assert — at the instant it expires it is expired, and the id was never wrong.
    should(actual).equal('expired');
  });

  it('should report a handle it never issued as unknown', () => {
    // Arrange
    const { store } = storeOf();

    // Act
    const actual = problemOf(() => store.require('fy_fprop_never0000000000'));

    // Assert
    should(actual).equal('unknown');
  });

  it('should bound how many changes await review at once', () => {
    // Arrange
    const { store } = storeOf();
    for (let index = 0; index < MAX_OPEN_PROPOSALS; index += 1) open(store);

    // Act
    const actual = problemOf(() => open(store));

    // Assert
    should(actual).equal('exhausted');
  });

  it('should not let applied changes consume the capacity for new ones', () => {
    // Arrange — the bound is on changes awaiting review, not on changes ever made.
    const { store } = storeOf();
    for (let index = 0; index < MAX_OPEN_PROPOSALS; index += 1) store.consumeAsHost(open(store).id);

    // Act
    const actual = open(store);

    // Assert
    should(actual.state).equal('pending');
  });

  it('should refuse to apply the same change twice', () => {
    // Arrange
    const { store } = storeOf();
    const proposal = open(store);
    store.consumeAsHost(proposal.id);

    // Act
    const actual = problemOf(() => store.require(proposal.id));

    // Assert
    should(actual).equal('consumed');
  });
});

describe('FleetProposalStore approvals', () => {
  it('should accept the code it minted, however the person typed it', () => {
    // Arrange
    const { store } = storeOf({ code: 'AAAA-BBBB' });
    const proposal = open(store);
    store.authorize(proposal.id);

    // Act
    const actual = store.consume(proposal.id, ' aaaa bbbb ');

    // Assert
    should(actual.state).equal('consumed');
  });

  it('should refuse an apply with no approval outstanding', () => {
    // Arrange
    const { store } = storeOf();
    const proposal = open(store);

    // Act
    const actual = problemOf(() => store.consume(proposal.id, 'AAAA-BBBB'));

    // Assert
    should(actual).equal('unauthorized');
  });

  it('should replace a previous approval so an abandoned code stops working', () => {
    // Arrange
    const { store } = storeOf();
    let issued = 0;
    const rotating = new FleetProposalStore<string>({
      now: () => 1_000_000,
      mintId: () => `rotate${String(issued).padStart(16, '0')}`,
      mintCode: () => (issued++ === 0 ? 'AAAA-BBBB' : 'CCCC-DDDD'),
    });
    const proposal = open(rotating);
    rotating.authorize(proposal.id);
    rotating.authorize(proposal.id);

    // Act
    const actual = problemOf(() => rotating.consume(proposal.id, 'AAAA-BBBB'));

    // Assert
    should(actual).equal('unauthorized');
    should(rotating.consume(proposal.id, 'CCCC-DDDD').state).equal('consumed');
    should(store).be.an.Object();
  });

  it('should treat the exact expiry instant as expired', () => {
    // Arrange
    const { store, clock } = storeOf();
    const proposal = open(store);
    store.authorize(proposal.id);

    // Act — not one millisecond past it; the instant itself.
    clock.value += FLEET_APPROVAL_TTL_SECONDS * 1000;
    const actual = problemOf(() => store.consume(proposal.id, 'AAAA-BBBB'));

    // Assert
    should(actual).equal('expired');
  });

  it('should stop accepting codes once the attempt budget is spent', () => {
    // Arrange
    const { store } = storeOf();
    const proposal = open(store);
    store.authorize(proposal.id);
    for (let attempt = 0; attempt < FLEET_APPROVAL_MAX_ATTEMPTS; attempt += 1) {
      should(problemOf(() => store.consume(proposal.id, 'ZZZZ-ZZZZ'))).equal('unauthorized');
    }

    // Act — even the right code, because the budget is spent.
    const actual = problemOf(() => store.consume(proposal.id, 'AAAA-BBBB'));

    // Assert
    should(actual).equal('exhausted');
  });

  it('should let a change be applied again after an apply that never reached the host', () => {
    // Arrange
    const { store } = storeOf();
    const proposal = open(store);
    const consumed = store.consumeAsHost(proposal.id);

    // Act
    store.restore(consumed);

    // Assert
    should(store.require(proposal.id).state).equal('pending');
  });
});

describe('redactProposal', () => {
  it('should never disclose the approval code, only that one is outstanding', () => {
    // Arrange
    const { store, clock } = storeOf({ code: 'AAAA-BBBB' });
    const proposal = open(store);
    store.authorize(proposal.id);

    // Act
    const actual = redactProposal(store.require(proposal.id), payload => `view of ${payload}`);

    // Assert
    should(JSON.stringify(actual)).not.match(/AAAA-BBBB/u);
    should(actual.approval).match({ outstanding: true });
    should(actual.approval?.expiresAt).equal(new Date(clock.value + FLEET_APPROVAL_TTL_SECONDS * 1000).toISOString());
    should(actual.preview).equal('view of artifact');
  });

  it('should describe edited assets by size rather than by content', () => {
    // Arrange
    const { store } = storeOf();
    const proposal = store.open({
      revision: 'rev',
      mutation: INITIALIZE,
      assetEdits: [{ path: 'CLAUDE.md', content: 'hello' }],
      assetRevisions: [],
      payload: 'artifact',
      summary: 'a change',
    });

    // Act
    const actual = redactProposal(proposal, () => 'view');

    // Assert
    should(actual.assetEdits).deepEqual([{ path: 'CLAUDE.md', bytes: 5 }]);
  });
});
