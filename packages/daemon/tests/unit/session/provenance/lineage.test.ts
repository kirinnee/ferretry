import { describe, it } from 'bun:test';
import should from 'should';
import {
  parseSessionProvenance,
  resolveSpawnLabel,
  resolveWardenLineage,
  type SessionAncestor,
  type SessionProvenance,
} from '../../../../src/lib/session/provenance/index.ts';
import { WARDEN_LABEL } from '../../../../src/lib/warden/index.ts';

const STAMPED_AT = '2026-07-30T12:00:00.000Z';

const stamp = (overrides: Partial<SessionProvenance> = {}): SessionProvenance => ({
  v: 1,
  at: STAMPED_AT,
  origin: 'session',
  wardenLineage: false,
  lineageSource: 'none',
  ...overrides,
});

const fleetOf = (...ancestors: readonly SessionAncestor[]): ReadonlyMap<string, SessionAncestor> =>
  new Map(ancestors.map(ancestor => [ancestor.id, ancestor]));

describe('resolveWardenLineage', () => {
  it('should treat the warden label on the request itself as descent traced to the new session', () => {
    // Arrange / Act
    const decision = resolveWardenLineage({ id: 'w1', label: WARDEN_LABEL }, fleetOf());

    // Assert
    should(decision).eql({ wardenLineage: true, lineageSource: 'self_label', warden: 'w1' });
  });

  it('should trim the requested label before matching the warden label', () => {
    // Arrange / Act
    const decision = resolveWardenLineage({ id: 'w2', label: `  ${WARDEN_LABEL}  ` }, fleetOf());

    // Assert
    should(decision.lineageSource).eql('self_label');
  });

  it('should prefer the parent stamp over any walking', () => {
    // Arrange: the parent is stamped but carries no warden label of its own, and
    // its own parent is absent — exactly the pruned-warden case.
    const fleet = fleetOf({
      id: 'child',
      parent: 'pruned-warden',
      provenance: stamp({ wardenLineage: true, lineageSource: 'self_label', warden: 'pruned-warden' }),
    });

    // Act
    const decision = resolveWardenLineage({ id: 'grandchild', parent: 'child' }, fleet);

    // Assert
    should(decision).eql({ wardenLineage: true, lineageSource: 'parent_stamp', warden: 'pruned-warden' });
  });

  it('should fall back to the parent id when a stamped ancestor names no warden', () => {
    // Arrange: a stamp written by an older daemon can record descent without the
    // traceback, so the nearest known session is the best answer available.
    const fleet = fleetOf({ id: 'child', provenance: stamp({ wardenLineage: true, lineageSource: 'self_label' }) });

    // Act
    const decision = resolveWardenLineage({ id: 'grandchild', parent: 'child' }, fleet);

    // Assert
    should(decision.warden).eql('child');
  });

  it('should walk the parent chain for an unstamped labelled warden ancestor', () => {
    // Arrange
    const fleet = fleetOf({ id: 'mid', parent: 'warden' }, { id: 'warden', label: WARDEN_LABEL });

    // Act
    const decision = resolveWardenLineage({ id: 'leaf', parent: 'mid' }, fleet);

    // Assert
    should(decision).eql({ wardenLineage: true, lineageSource: 'ancestor_walk', warden: 'warden' });
  });

  it('should find descent on the walk through an ancestor stamped but unlabelled', () => {
    // Arrange: only reachable by the walk, because the immediate parent is clean.
    const fleet = fleetOf(
      { id: 'mid', parent: 'shielded' },
      { id: 'shielded', provenance: stamp({ wardenLineage: true, lineageSource: 'parent_stamp', warden: 'w9' }) },
    );

    // Act
    const decision = resolveWardenLineage({ id: 'leaf', parent: 'mid' }, fleet);

    // Assert
    should(decision).eql({ wardenLineage: true, lineageSource: 'ancestor_walk', warden: 'w9' });
  });

  it('should report no descent for a root session', () => {
    // Arrange / Act
    const decision = resolveWardenLineage({ id: 'solo' }, fleetOf());

    // Assert
    should(decision).eql({ wardenLineage: false, lineageSource: 'none' });
  });

  it('should NOT treat an unresolvable parent as warden descent', () => {
    // Arrange: shielding every orphan would disable supervision for all of them.
    // Act
    const decision = resolveWardenLineage({ id: 'leaf', parent: 'gone' }, fleetOf());

    // Assert
    should(decision.wardenLineage).eql(false);
  });

  it('should stop a cyclic parent chain instead of looping', () => {
    // Arrange
    const fleet = fleetOf({ id: 'a', parent: 'b' }, { id: 'b', parent: 'a' });

    // Act
    const decision = resolveWardenLineage({ id: 'leaf', parent: 'a' }, fleet);

    // Assert
    should(decision.wardenLineage).eql(false);
  });

  it('should stop a chain that points back at the session being spawned', () => {
    // Arrange: a parent whose own parent is the new id must not be re-entered.
    const fleet = fleetOf({ id: 'parent', parent: 'leaf' });

    // Act
    const decision = resolveWardenLineage({ id: 'leaf', parent: 'parent' }, fleet);

    // Assert
    should(decision.wardenLineage).eql(false);
  });
});

describe('resolveSpawnLabel', () => {
  it('should force the warden label on a descendant over the requested one', () => {
    // Arrange / Act
    const label = resolveSpawnLabel({ label: 'my-batch' }, undefined, {
      wardenLineage: true,
      lineageSource: 'parent_stamp',
      warden: 'w1',
    });

    // Assert
    should(label).eql(WARDEN_LABEL);
  });

  it('should keep an explicit label when there is no descent', () => {
    // Arrange / Act
    const label = resolveSpawnLabel(
      { label: ' my-batch ' },
      { id: 'p', label: 'other' },
      {
        wardenLineage: false,
        lineageSource: 'none',
      },
    );

    // Assert
    should(label).eql('my-batch');
  });

  it('should inherit the parent label when none was requested', () => {
    // Arrange / Act
    const label = resolveSpawnLabel({}, { id: 'p', label: 'tree' }, { wardenLineage: false, lineageSource: 'none' });

    // Assert
    should(label).eql('tree');
  });

  it.each([
    { name: 'a blank request and a blank parent label', request: '   ', parent: '  ' },
    { name: 'no request and no parent', request: undefined, parent: undefined },
  ])('should yield no label for $name', ({ request, parent }) => {
    // Arrange / Act
    const label = resolveSpawnLabel(
      request === undefined ? {} : { label: request },
      parent === undefined ? undefined : { id: 'p', label: parent },
      { wardenLineage: false, lineageSource: 'none' },
    );

    // Assert
    should(label).eql(undefined);
  });
});

describe('parseSessionProvenance', () => {
  it('should accept a consistent stamp', () => {
    // Arrange
    const value = {
      v: 1,
      at: '2026-07-30T12:00:00+02:00',
      origin: 'warden',
      parent: 'p1',
      warden: 'w1',
      wardenLineage: true,
      lineageSource: 'parent_stamp',
    };

    // Act
    const parsed = parseSessionProvenance(value);

    // Assert: the instant is canonicalized to UTC on the way in.
    should(parsed?.at).eql('2026-07-30T10:00:00.000Z');
    should(parsed?.warden).eql('w1');
  });

  it.each([
    {
      name: 'lineage true with a source of none',
      value: { v: 1, at: STAMPED_AT, origin: 'human', wardenLineage: true, lineageSource: 'none', warden: 'w1' },
    },
    {
      name: 'lineage false with a real source',
      value: { v: 1, at: STAMPED_AT, origin: 'human', wardenLineage: false, lineageSource: 'self_label' },
    },
    {
      name: 'a descendant naming no warden',
      value: { v: 1, at: STAMPED_AT, origin: 'warden', wardenLineage: true, lineageSource: 'self_label' },
    },
    {
      name: 'a future version',
      value: { v: 2, at: STAMPED_AT, origin: 'human', wardenLineage: false, lineageSource: 'none' },
    },
    {
      name: 'a non-instant timestamp',
      value: { v: 1, at: 'yesterday', origin: 'human', wardenLineage: false, lineageSource: 'none' },
    },
    { name: 'a missing payload', value: undefined },
  ])('should refuse $name', ({ value }) => {
    // Arrange / Act / Assert
    should(parseSessionProvenance(value)).eql(undefined);
  });
});
