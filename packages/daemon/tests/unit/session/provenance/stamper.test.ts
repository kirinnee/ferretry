import { describe, it } from 'bun:test';
import should from 'should';
import {
  parseSessionProvenance,
  SessionProvenanceStamper,
  type SessionAncestor,
  type SessionProvenance,
} from '../../../../src/lib/session/provenance/index.ts';
import { WARDEN_LABEL } from '../../../../src/lib/warden/index.ts';

const SPAWNED_AT = '2026-07-30T12:00:00.000Z';
const RESUMED_AT = '2026-07-31T09:00:00.000Z';

const stamperAt = (instant: string): SessionProvenanceStamper => new SessionProvenanceStamper({ now: () => instant });

const fleetOf = (...ancestors: readonly SessionAncestor[]): ReadonlyMap<string, SessionAncestor> =>
  new Map(ancestors.map(ancestor => [ancestor.id, ancestor]));

const wardenStamp: SessionProvenance = {
  v: 1,
  at: SPAWNED_AT,
  origin: 'warden',
  warden: 'w1',
  wardenLineage: true,
  lineageSource: 'self_label',
};

describe('SessionProvenanceStamper.stamp', () => {
  it('should stamp a warden with its own id as the traceback', () => {
    // Arrange / Act
    const stamped = stamperAt(SPAWNED_AT).stamp({ id: 'w1', label: WARDEN_LABEL, requestedByHuman: false }, fleetOf());

    // Assert
    should(stamped.provenance).eql({
      v: 1,
      at: SPAWNED_AT,
      origin: 'warden',
      warden: 'w1',
      wardenLineage: true,
      lineageSource: 'self_label',
    });
    should(stamped.label).eql(WARDEN_LABEL);
  });

  it('should stamp a session a warden spawned even when the warden itself is gone', () => {
    // Arrange: only the parent survives, and it survives because it was stamped.
    const fleet = fleetOf({ id: 'child', label: WARDEN_LABEL, parent: 'w1', provenance: wardenStamp });

    // Act
    const stamped = stamperAt(SPAWNED_AT).stamp(
      { id: 'grandchild', label: 'my-batch', parent: 'child', requestedByHuman: true },
      fleet,
    );

    // Assert: the requested label is overridden and the traceback survives.
    should(stamped.provenance).eql({
      v: 1,
      at: SPAWNED_AT,
      origin: 'warden',
      parent: 'child',
      warden: 'w1',
      wardenLineage: true,
      lineageSource: 'parent_stamp',
    });
    should(stamped.label).eql(WARDEN_LABEL);
  });

  it('should record a human-requested root session as human-originated', () => {
    // Arrange / Act
    const stamped = stamperAt(SPAWNED_AT).stamp({ id: 's1', requestedByHuman: true }, fleetOf());

    // Assert
    should(stamped.provenance.origin).eql('human');
    should(stamped.label).eql(undefined);
  });

  it('should record a root session nobody claimed as session-originated', () => {
    // Arrange / Act
    const stamped = stamperAt(SPAWNED_AT).stamp({ id: 's1', requestedByHuman: false }, fleetOf());

    // Assert
    should(stamped.provenance.origin).eql('session');
  });

  it('should record a parented session as session-originated even when a human asked', () => {
    // Arrange
    const fleet = fleetOf({ id: 'p1', label: 'tree' });

    // Act
    const stamped = stamperAt(SPAWNED_AT).stamp({ id: 's1', parent: 'p1', requestedByHuman: true }, fleet);

    // Assert: the label is inherited so the tree groups together.
    should(stamped.provenance.origin).eql('session');
    should(stamped.provenance.parent).eql('p1');
    should(stamped.label).eql('tree');
  });

  it('should produce a stamp its own parser accepts', () => {
    // Arrange
    const stamped = stamperAt(SPAWNED_AT).stamp({ id: 'w1', label: WARDEN_LABEL, requestedByHuman: false }, fleetOf());

    // Act
    const parsed = parseSessionProvenance(stamped.provenance);

    // Assert
    should(parsed).eql(stamped.provenance);
  });
});

describe('SessionProvenanceStamper.restamp', () => {
  it('should stamp a resume of a session that never had a stamp', () => {
    // Arrange / Act
    const stamped = stamperAt(RESUMED_AT).restamp({ id: 's1', requestedByHuman: true }, fleetOf(), undefined);

    // Assert
    should(stamped.provenance.at).eql(RESUMED_AT);
    should(stamped.provenance.origin).eql('human');
  });

  it('should keep an existing shield when the warden ancestor has since been pruned', () => {
    // Arrange: this is the regression. Re-resolving alone would return no descent
    // because nothing in the fleet can prove it any more.
    const existing: SessionProvenance = {
      v: 1,
      at: SPAWNED_AT,
      origin: 'warden',
      parent: 'w1',
      warden: 'w1',
      wardenLineage: true,
      lineageSource: 'parent_stamp',
    };

    // Act
    const stamped = stamperAt(RESUMED_AT).restamp(
      { id: 's1', parent: 'w1', requestedByHuman: false },
      fleetOf(),
      existing,
    );

    // Assert
    should(stamped.provenance).eql(existing);
    should(stamped.label).eql(WARDEN_LABEL);
  });

  it('should adopt newly discovered descent on a resume', () => {
    // Arrange: the parent was stamped after this session was created.
    const existing: SessionProvenance = {
      v: 1,
      at: SPAWNED_AT,
      origin: 'session',
      parent: 'p1',
      wardenLineage: false,
      lineageSource: 'none',
    };
    const fleet = fleetOf({ id: 'p1', provenance: wardenStamp });

    // Act
    const stamped = stamperAt(RESUMED_AT).restamp({ id: 's1', parent: 'p1', requestedByHuman: false }, fleet, existing);

    // Assert: the shield is adopted and the origin is corrected, but the session's
    // own creation instant is not rewritten by a resume.
    should(stamped.provenance).eql({
      v: 1,
      at: SPAWNED_AT,
      origin: 'warden',
      parent: 'p1',
      warden: 'w1',
      wardenLineage: true,
      lineageSource: 'parent_stamp',
    });
    should(stamped.label).eql(WARDEN_LABEL);
  });

  it('should preserve the recorded origin and parent of an unshielded resume', () => {
    // Arrange: the request no longer carries the parent — a revive that lost it
    // must not rewrite the session into a root.
    const existing: SessionProvenance = {
      v: 1,
      at: SPAWNED_AT,
      origin: 'human',
      parent: 'p1',
      wardenLineage: false,
      lineageSource: 'none',
    };

    // Act
    const stamped = stamperAt(RESUMED_AT).restamp({ id: 's1', requestedByHuman: false }, fleetOf(), existing);

    // Assert
    should(stamped.provenance.at).eql(SPAWNED_AT);
    should(stamped.provenance.origin).eql('human');
    should(stamped.provenance.parent).eql('p1');
  });

  it('should leave a root session without a parent on resume', () => {
    // Arrange
    const existing: SessionProvenance = {
      v: 1,
      at: SPAWNED_AT,
      origin: 'human',
      wardenLineage: false,
      lineageSource: 'none',
    };

    // Act
    const stamped = stamperAt(RESUMED_AT).restamp({ id: 's1', requestedByHuman: true }, fleetOf(), existing);

    // Assert
    should(stamped.provenance.parent).eql(undefined);
  });
});
