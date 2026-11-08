import { describe, it } from 'bun:test';
import should from 'should';
import { FleetProposalRefusal, FleetProposalStore } from '../../../daemon/lib/service/proposals.ts';

const FIFTEEN_MINUTES = 15 * 60 * 1000;

type Store = FleetProposalStore<string, string>;

/** A store whose clock and identity source the test moves by hand. */
function rig(mint?: () => string) {
  let now = 1_000;
  let counter = 0;
  const store: Store = new FleetProposalStore<string, string>({
    now: () => now,
    mintId: mint ?? (() => `id${String(++counter)}`),
  });
  return {
    store,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const staged = (label: string) => ({ revision: 'rev', mutation: `mutation-${label}`, payload: label, summary: label });

const refusal = (run: () => unknown): FleetProposalRefusal => {
  try {
    run();
  } catch (error) {
    if (error instanceof FleetProposalRefusal) return error;
    throw error;
  }
  throw new Error('expected a FleetProposalRefusal');
};

describe('FleetProposalStore', () => {
  it('should stage a pending proposal that expires fifteen minutes after it was made', () => {
    // Arrange
    const { store } = rig();

    // Act
    const actual = store.open(staged('a'));

    // Assert
    should(actual.id).equal('fy_fprop_id1');
    should(actual.state).equal('pending');
    should(actual.expiresAt - actual.createdAt).equal(FIFTEEN_MINUTES);
    should(store.require(actual.id)).equal(actual);
  });

  it('should refuse a ninth open proposal as exhausted and say how to make room', () => {
    // Arrange
    const { store } = rig();
    for (let index = 0; index < 8; index += 1) store.open(staged(String(index)));

    // Act
    const actual = refusal(() => store.open(staged('ninth')));

    // Assert
    should(actual.problem).equal('exhausted');
    should(actual.name).equal('FleetProposalRefusal');
    should(actual.message).containEql('8 fleet changes awaiting review');
  });

  it('should not count an applied proposal against the bound on open ones', () => {
    // Arrange
    const { store } = rig();
    const first = store.open(staged('first'));
    for (let index = 0; index < 7; index += 1) store.open(staged(String(index)));
    store.consume(first.id);

    // Act
    const actual = store.open(staged('after'));

    // Assert
    should(actual.state).equal('pending');
  });

  it('should refuse to mint a handle when the identity source keeps repeating one already held', () => {
    // Arrange
    const { store } = rig(() => 'same');
    store.open(staged('held'));

    // Act
    const actual = refusal(() => store.open(staged('clash')));

    // Assert
    should(actual.problem).equal('exhausted');
    should(actual.message).containEql('will not replace a change already held');
    should(store.require('fy_fprop_same').payload).equal('held');
  });

  it('should retry a repeated handle and keep the first change when a later mint is free', () => {
    // Arrange
    const minted = ['same', 'same', 'other'];
    const { store } = rig(() => minted.shift() ?? 'spare');
    const held = store.open(staged('held'));

    // Act
    const actual = store.open(staged('second'));

    // Assert
    should(actual.id).equal('fy_fprop_other');
    should(store.require(held.id).payload).equal('held');
  });

  it('should say a timed-out proposal expired, not that it never existed', () => {
    // Arrange
    const { store, advance } = rig();
    const { id } = store.open(staged('a'));
    advance(FIFTEEN_MINUTES);

    // Act
    const actual = refusal(() => store.require(id));

    // Assert
    should(actual.problem).equal('expired');
    should(actual.message).containEql(`"${id}" expired before it was applied`);
    should(refusal(() => store.require(id)).problem).equal('unknown');
  });

  it('should say an id it never held is unknown', () => {
    // Arrange
    const { store } = rig();

    // Act
    const actual = refusal(() => store.require('fy_fprop_missing'));

    // Assert
    should(actual.problem).equal('unknown');
    should(actual.message).containEql('no open fleet proposal with id "fy_fprop_missing"');
  });

  it('should spend a proposal once and tell a repeat apply it already happened', () => {
    // Arrange
    const { store } = rig();
    const { id } = store.open(staged('a'));

    // Act
    const first = store.consume(id);
    const repeat = refusal(() => store.consume(id));

    // Assert
    should(first.state).equal('consumed');
    should(repeat.problem).equal('consumed');
    should(repeat.message).containEql('has already been applied');
  });

  it('should put a consumed proposal back when the apply never reached the host', () => {
    // Arrange
    const { store } = rig();
    const record = store.consume(store.open(staged('a')).id);

    // Act
    store.restore(record);

    // Assert
    should(store.require(record.id).state).equal('pending');
  });

  it('should not bring back a proposal the store no longer holds', () => {
    // Arrange
    const { store, advance } = rig();
    const record = store.consume(store.open(staged('a')).id);
    advance(FIFTEEN_MINUTES);
    store.open(staged('sweeps the old one'));

    // Act
    store.restore(record);

    // Assert
    should(record.state).equal('consumed');
    should(refusal(() => store.require(record.id)).problem).equal('unknown');
  });

  it('should remember only the sixteen newest applied changes', () => {
    // Arrange
    const { store, advance } = rig();
    const ids: string[] = [];
    for (let index = 0; index < 17; index += 1) {
      advance(1);
      const { id } = store.open(staged(String(index)));
      store.consume(id);
      ids.push(id);
    }

    // Act
    const oldest = refusal(() => store.require(ids[0] as string));
    const newest = refusal(() => store.require(ids[16] as string));

    // Assert
    should(oldest.problem).equal('unknown');
    should(newest.problem).equal('consumed');
    should(refusal(() => store.require(ids[1] as string)).problem).equal('consumed');
  });
});
