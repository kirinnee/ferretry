import type { SessionProvenance } from '@ferretry/protocol';
import { describe, expect, it } from 'bun:test';
import {
  type SessionAncestor,
  SessionProvenanceRecorder,
  SessionProvenanceStamper,
  type SessionProvenanceRecord,
  type SessionProvenanceStore,
} from '../../../../src/lib/session/provenance/index.ts';

const AT = '2026-08-06T07:00:00.000Z';
const LATER = '2026-08-06T09:00:00.000Z';

/** Records every write, so "wrote nothing" is a fact a test can assert rather than infer. */
class FakeStore implements SessionProvenanceStore {
  readonly writes: Array<{ readonly sessionId: string; readonly record: SessionProvenanceRecord }> = [];
  readonly labels = new Map<string, string>();

  constructor(private readonly stored: Map<string, SessionProvenance> = new Map()) {}

  async read(sessionId: string): Promise<SessionProvenanceRecord> {
    const provenance = this.stored.get(sessionId);
    return {
      ...(provenance === undefined ? {} : { provenance }),
      ...(this.labels.get(sessionId) === undefined ? {} : { label: this.labels.get(sessionId) }),
    };
  }

  async write(sessionId: string, record: SessionProvenanceRecord): Promise<void> {
    this.writes.push({ sessionId, record });
    if (record.provenance !== undefined) this.stored.set(sessionId, record.provenance);
    if (record.label === undefined) this.labels.delete(sessionId);
    else this.labels.set(sessionId, record.label);
  }
}

function recorder(
  stored: Map<string, SessionProvenance> = new Map(),
  fleet: readonly SessionAncestor[] = [],
  label: string | undefined = undefined,
): { readonly recorder: SessionProvenanceRecorder; readonly store: FakeStore } {
  const store = new FakeStore(stored);
  if (label !== undefined) store.labels.set('session-1', label);
  return {
    store,
    recorder: new SessionProvenanceRecorder(new SessionProvenanceStamper({ now: () => LATER }), store, {
      snapshot: async () => new Map(fleet.map(ancestor => [ancestor.id, ancestor])),
    }),
  };
}

const shielded = (overrides: Partial<SessionProvenance> = {}): SessionProvenance => ({
  v: 1,
  at: AT,
  origin: 'warden',
  parent: 'warden-7',
  warden: 'warden-7',
  wardenLineage: true,
  lineageSource: 'parent_stamp',
  ...overrides,
});

describe('SessionProvenanceRecorder', () => {
  /**
   * The gap this service exists for. A session created before stamping existed carries none, and the
   * lifecycle cannot deliver one — `configDocument` merges `{ ...envelope, ...stored, ...record
   * .config }`, so a stored document beats the envelope and a re-stamp can never ride a transition.
   */
  it('stamps a session that has never carried one', async () => {
    const { recorder: service, store } = recorder();

    const recorded = await service.recordRelaunch({ id: 'session-1', requestedByHuman: true });

    expect(recorded.written).toBe(true);
    expect(store.writes).toHaveLength(1);
    expect(recorded.provenance.origin).toBe('human');
    expect(recorded.provenance.wardenLineage).toBe(false);
    expect(recorded.provenance.at).toBe(LATER);
  });

  it('writes nothing when the stored stamp already says exactly this', async () => {
    const unshielded: SessionProvenance = {
      v: 1,
      at: AT,
      origin: 'human',
      wardenLineage: false,
      lineageSource: 'none',
    };
    const { recorder: service, store } = recorder(new Map([['session-1', unshielded]]));

    const recorded = await service.recordRelaunch({ id: 'session-1', requestedByHuman: true });

    // A revive of an already-correct session is the common case by a wide margin: an unconditional
    // write would rewrite every session's config on every revive, widening the torn-write window on
    // a document whose whole purpose is to survive.
    expect(recorded.written).toBe(false);
    expect(store.writes).toEqual([]);
    expect(recorded.provenance).toEqual(unshielded);
  });

  /**
   * The monotonicity rule this service must NOT re-implement: `restamp` returns the recorded stamp
   * verbatim once descent is on record, so a warden pruned since the spawn cannot unshield its
   * offspring. Here the fleet is empty, which is exactly the pruned-warden situation.
   */
  it('never weakens a stored shield, even when nothing in the fleet resolves any more', async () => {
    const { recorder: service, store } = recorder(new Map([['session-1', shielded()]]), [], 'fleet-warden');

    const recorded = await service.recordRelaunch({ id: 'session-1', parent: 'warden-7', requestedByHuman: false });

    expect(recorded.provenance).toEqual(shielded());
    expect(recorded.provenance.wardenLineage).toBe(true);
    expect(recorded.label).toBe('fleet-warden');
    // Stamp and label both already correct, so nothing was written — the shield is kept by not
    // touching it.
    expect(store.writes).toEqual([]);
  });

  /**
   * THE TWO HALVES OF ONE DECISION MUST BE WRITTEN TOGETHER.
   *
   * A session discovered to be warden-descended on THIS relaunch gets `wardenLineage: true`. If the
   * label were left as it was, the document would carry a shield the stamp asserts and the label
   * denies — and `inWardenLineage` checks the label first, so the disagreement stays invisible until
   * somebody edits it.
   */
  it('forces the warden label onto a session newly discovered to be a descendant', async () => {
    const { recorder: service, store } = recorder(new Map(), [{ id: 'warden-7', label: 'fleet-warden' }], 'team');

    const recorded = await service.recordRelaunch({
      id: 'session-1',
      label: 'team',
      parent: 'warden-7',
      requestedByHuman: false,
    });

    expect(recorded.provenance.wardenLineage).toBe(true);
    expect(recorded.label).toBe('fleet-warden');
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]?.record.label).toBe('fleet-warden');
  });

  /** The same defect from the other side: an already-shielded session whose label has since drifted. */
  it('repairs a drifted label even when the stamp itself is unchanged', async () => {
    const { recorder: service, store } = recorder(new Map([['session-1', shielded()]]), [], 'team');

    const recorded = await service.recordRelaunch({ id: 'session-1', parent: 'warden-7', requestedByHuman: false });

    // Comparing only the stamp would answer `written: false` here and repair nothing.
    expect(recorded.written).toBe(true);
    expect(recorded.label).toBe('fleet-warden');
    expect(store.writes[0]?.record.provenance).toEqual(shielded());
    expect(await store.read('session-1')).toEqual({ provenance: shielded(), label: 'fleet-warden' });
  });

  /**
   * A NONCANONICAL LABEL IS REPAIRED ONCE, THEN LEFT ALONE.
   *
   * The comparison is against the STORED value raw, not a normalised copy of it. Normalising both
   * sides would read `'   '` as already equal to "no label" and leave that value on disk forever —
   * and nothing downstream trims, so a surface grouping by label puts the session in a whitespace
   * group of one. One exact mismatch write removes the key; the next relaunch compares `undefined`
   * to `undefined` and writes nothing.
   */
  it('canonicalises a blank stored label in one write, and then stops', async () => {
    const unshielded: SessionProvenance = {
      v: 1,
      at: AT,
      origin: 'human',
      wardenLineage: false,
      lineageSource: 'none',
    };
    const { recorder: service, store } = recorder(new Map([['session-1', unshielded]]), [], '   ');

    const repaired = await service.recordRelaunch({ id: 'session-1', requestedByHuman: true });
    const settled = await service.recordRelaunch({ id: 'session-1', requestedByHuman: true });

    expect(repaired.written).toBe(true);
    expect(repaired.label).toBeUndefined();
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]?.record.label).toBeUndefined();
    // Converged: the stored key is gone, so the second relaunch has nothing to repair.
    expect(settled.written).toBe(false);
    expect(store.writes).toHaveLength(1);
  });

  it('canonicalises a padded label rather than accepting it as already correct', async () => {
    const { recorder: service, store } = recorder(new Map([['session-1', shielded()]]), [], ' fleet-warden ');

    const recorded = await service.recordRelaunch({ id: 'session-1', parent: 'warden-7', requestedByHuman: false });

    // Exact consumers do not trim, so ` fleet-warden ` is a different label from `fleet-warden`.
    expect(recorded.written).toBe(true);
    expect(store.writes[0]?.record.label).toBe('fleet-warden');
  });

  it('keeps the original spawn instant when it brings an unshielded stamp up to date', async () => {
    const stale: SessionProvenance = {
      v: 1,
      at: AT,
      origin: 'session',
      parent: 'boss-1',
      wardenLineage: false,
      lineageSource: 'none',
    };
    const { recorder: service, store } = recorder(new Map([['session-1', stale]]), [
      { id: 'warden-7', label: 'fleet-warden' },
    ]);

    const recorded = await service.recordRelaunch({ id: 'session-1', parent: 'warden-7', requestedByHuman: false });

    // Descent is newly discovered, so this IS a change and is written; the spawn instant is history
    // and a relaunch does not rewrite it.
    expect(recorded.written).toBe(true);
    expect(recorded.provenance.at).toBe(AT);
    expect(recorded.provenance.wardenLineage).toBe(true);
    expect(recorded.provenance.warden).toBe('warden-7');
    expect(store.writes).toHaveLength(1);
  });

  /**
   * AN UNREADABLE FLEET MUST NOT BECOME AN EMPTY ONE.
   *
   * Lineage resolves against the ancestry snapshot, so answering `[]` for a read that failed would
   * turn an absent fact into a NEGATIVE one and resolve `wardenLineage: false` for a session that
   * really is warden offspring — after which the detector supervises and escalates against a
   * warden's own child, which is the loop the stamp exists to close. The failure therefore
   * propagates, and the revive path's own catch leaves the durable record exactly as it was.
   */
  it('writes nothing when the ancestry cannot be read', async () => {
    const store = new FakeStore(new Map());
    const unreadable = new SessionProvenanceRecorder(new SessionProvenanceStamper({ now: () => LATER }), store, {
      snapshot: async () => {
        throw new Error('the session index is unavailable');
      },
    });

    await expect(
      unreadable.recordRelaunch({ id: 'session-1', parent: 'warden-7', requestedByHuman: false }),
    ).rejects.toThrow('the session index is unavailable');
    expect(store.writes).toEqual([]);
  });

  it('leaves a stored shield untouched when the ancestry cannot be read', async () => {
    const store = new FakeStore(new Map([['session-1', shielded()]]));
    const unreadable = new SessionProvenanceRecorder(new SessionProvenanceStamper({ now: () => LATER }), store, {
      snapshot: async () => {
        throw new Error('the session index is unavailable');
      },
    });

    await expect(unreadable.recordRelaunch({ id: 'session-1', requestedByHuman: false })).rejects.toThrow();
    // The shield survives because nothing was written, not because something decided to keep it.
    expect(store.writes).toEqual([]);
    expect((await store.read('session-1')).provenance).toEqual(shielded());
  });

  it('carries the session current label and parent into the decision', async () => {
    const { recorder: service } = recorder(new Map(), [{ id: 'boss-1', label: 'team' }]);

    const recorded = await service.recordRelaunch({
      id: 'session-1',
      label: 'team',
      parent: 'boss-1',
      requestedByHuman: false,
    });

    // A relaunch that passed an empty shell would drop the group the session belongs to, because the
    // label the stamper answers with is what the session is stored under.
    expect(recorded.label).toBe('team');
    expect(recorded.provenance.parent).toBe('boss-1');
    expect(recorded.provenance.origin).toBe('session');
  });
});
