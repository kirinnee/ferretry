import { describe, it } from 'bun:test';
import should from 'should';
import type { FleetMutation } from '../../../src/lib/fleet/mutations.ts';
import {
  type FleetProposalProblem,
  FleetProposalRefusal,
  FleetProposalStore,
  MAX_OPEN_PROPOSALS,
  PROPOSAL_TTL_SECONDS,
  redactProposal,
} from '../../../src/lib/fleet/proposals.ts';

const INITIALIZE: FleetMutation = { kind: 'initialize' };

interface Clock {
  value: number;
}

function storeOf(options: { readonly ids?: readonly string[] } = {}): {
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
    for (let index = 0; index < MAX_OPEN_PROPOSALS; index += 1) store.consume(open(store).id);

    // Act
    const actual = open(store);

    // Assert
    should(actual.state).equal('pending');
  });

  it('should refuse to apply the same change twice', () => {
    // Arrange
    const { store } = storeOf();
    const proposal = open(store);
    store.consume(proposal.id);

    // Act
    const actual = problemOf(() => store.require(proposal.id));

    // Assert
    should(actual).equal('consumed');
  });
});

describe('FleetProposalStore consume', () => {
  it('should decide nothing about the caller, because that is no longer its question', () => {
    // The store used to demand a host-minted code here, which made it a second authority system
    // beside the capability model. Spending a change now takes nothing but the change's own handle;
    // WHO may spend it is settled at the authorization boundary before this is reached.
    // Arrange
    const { store } = storeOf();
    const proposal = open(store);

    // Act
    const actual = store.consume(proposal.id);

    // Assert
    should(actual.state).equal('consumed');
    should(store.consume).have.length(1);
  });

  it('should refuse to spend a change that timed out rather than applying a stale artifact', () => {
    // Arrange
    const { store, clock } = storeOf();
    const proposal = open(store);

    // Act
    clock.value += PROPOSAL_TTL_SECONDS * 1000;
    const actual = problemOf(() => store.consume(proposal.id));

    // Assert
    should(actual).equal('expired');
  });

  it('should let a change be applied again after an apply that never reached the host', () => {
    // Arrange
    const { store } = storeOf();
    const proposal = open(store);
    const consumed = store.consume(proposal.id);

    // Act
    store.restore(consumed);

    // Assert
    should(store.require(proposal.id).state).equal('pending');
  });

  it('should not restore a change the store no longer holds', () => {
    // Arrange — a tombstone that has already been retired is history, not capacity.
    const { store } = storeOf();
    const consumed = store.consume(open(store).id);
    for (let index = 0; index < 20; index += 1) store.consume(open(store).id);

    // Act
    store.restore(consumed);

    // Assert
    should(problemOf(() => store.require(consumed.id))).equal('unknown');
  });
});

describe('redactProposal', () => {
  it('should carry the staged change and never the artifact it was built from', () => {
    // Arrange
    const { store } = storeOf();
    const proposal = open(store);

    // Act
    const actual = redactProposal(store.require(proposal.id), payload => `view of ${payload}`);

    // Assert — the view is what the daemon derived, never the payload itself.
    should(actual.preview).equal('view of artifact');
    should(JSON.stringify(actual)).not.match(/"artifact"/u);
    // The approval field is structurally gone rather than filtered: there is no longer a second
    // credential for this shape to have disclosed the existence of.
    should(actual).not.have.property('approval');
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
