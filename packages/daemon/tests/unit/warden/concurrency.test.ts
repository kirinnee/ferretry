import { describe, it } from 'bun:test';
import should from 'should';
import { decideAssignedWardens, wardenSlotsFree, type WardenGateInput } from '../../../src/lib/warden/index.ts';

const gate = (overrides: Partial<WardenGateInput> = {}): WardenGateInput => ({
  maxConcurrent: 1,
  live: [],
  candidates: [],
  queued: [],
  isStillSuspect: () => true,
  ...overrides,
});

describe('warden slot budget', () => {
  it.each([
    { label: 'a free cap of one', cap: 1, liveCount: 0, expected: 1 },
    { label: 'a filled cap', cap: 1, liveCount: 1, expected: 0 },
    { label: 'more live wardens than the cap', cap: 1, liveCount: 4, expected: 0 },
    { label: 'a larger cap', cap: 3, liveCount: 1, expected: 2 },
    { label: 'a zero cap clamped to one', cap: 0, liveCount: 0, expected: 1 },
    { label: 'a negative cap clamped to one', cap: -5, liveCount: 0, expected: 1 },
    { label: 'a fractional cap floored', cap: 2.9, liveCount: 0, expected: 2 },
    { label: 'a negative live count floored', cap: 2, liveCount: -3, expected: 2 },
  ])('should compute $label', ({ cap, liveCount, expected }) => {
    // Arrange / Act / Assert
    should(wardenSlotsFree(cap, liveCount)).eql(expected);
  });
});

describe('assigned warden gate', () => {
  it('should spawn a fresh candidate when a slot is free', () => {
    // Arrange / Act
    const decision = decideAssignedWardens(gate({ candidates: ['s1'] }));

    // Assert
    should(decision).eql({ spawn: ['s1'], queue: [], dropped: [] });
  });

  it('should let a live sweep warden with no target fill the cap', () => {
    // Arrange
    const input = gate({ live: [{ wardenId: 'w-sweep' }], candidates: ['s1'] });

    // Act
    const decision = decideAssignedWardens(input);

    // Assert
    should(decision.spawn).be.empty();
    should(decision.queue).eql(['s1']);
  });

  it('should never open a second warden on a target already under investigation', () => {
    // Arrange
    const input = gate({
      maxConcurrent: 5,
      live: [{ wardenId: 'w1', targetId: 's1' }],
      candidates: ['s1', 's2'],
    });

    // Act
    const decision = decideAssignedWardens(input);

    // Assert
    should(decision.spawn).eql(['s2']);
    should(decision.queue).be.empty();
    should(decision.dropped).be.empty();
  });

  it('should retry queued targets before fresh candidates', () => {
    // Arrange
    const input = gate({ maxConcurrent: 2, queued: ['old1', 'old2'], candidates: ['new1'] });

    // Act
    const decision = decideAssignedWardens(input);

    // Assert
    should(decision.spawn).eql(['old1', 'old2']);
    should(decision.queue).eql(['new1']);
  });

  it('should collapse a target that appears in both the queue and this sweep', () => {
    // Arrange
    const input = gate({ maxConcurrent: 5, queued: ['s1'], candidates: ['s1', 's2'] });

    // Act
    const decision = decideAssignedWardens(input);

    // Assert
    should(decision.spawn).eql(['s1', 's2']);
  });

  it('should queue rather than drop a still-suspect target with no free slot', () => {
    // Arrange
    const input = gate({ maxConcurrent: 1, candidates: ['s1', 's2', 's3'] });

    // Act
    const decision = decideAssignedWardens(input);

    // Assert
    should(decision.spawn).eql(['s1']);
    should(decision.queue).eql(['s2', 's3']);
    should(decision.dropped).be.empty();
  });

  it('should drop a queued target that has recovered', () => {
    // Arrange
    const input = gate({
      maxConcurrent: 5,
      queued: ['recovered', 's2'],
      isStillSuspect: id => id !== 'recovered',
    });

    // Act
    const decision = decideAssignedWardens(input);

    // Assert
    should(decision.dropped).eql(['recovered']);
    should(decision.spawn).eql(['s2']);
  });

  it('should not report a fresh candidate that is no longer suspect as a drop', () => {
    // Arrange
    const input = gate({ maxConcurrent: 5, candidates: ['gone'], isStillSuspect: () => false });

    // Act
    const decision = decideAssignedWardens(input);

    // Assert
    should(decision).eql({ spawn: [], queue: [], dropped: [] });
  });

  it('should not treat a target already under investigation as dropped', () => {
    // Arrange
    const input = gate({
      maxConcurrent: 5,
      live: [{ wardenId: 'w1', targetId: 's1' }],
      queued: ['s1'],
      isStillSuspect: () => false,
    });

    // Act
    const decision = decideAssignedWardens(input);

    // Assert
    should(decision.dropped).be.empty();
    should(decision.queue).be.empty();
  });

  it('should decide nothing when there is nothing to decide', () => {
    // Arrange / Act
    const decision = decideAssignedWardens(gate());

    // Assert
    should(decision).eql({ spawn: [], queue: [], dropped: [] });
  });
});
