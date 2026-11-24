import { describe, expect, test } from 'bun:test';
import {
  type RegisteredAncestor,
  StorageSessionAncestry,
} from '../../../../../daemon/adapters/session/provenance/storage-session-ancestry.ts';
import type { DaemonStorage } from '../../../../../daemon/adapters/storage/session-storage.ts';
import { parseSessionId, type SessionId } from '../../../../../daemon/lib/session-id.ts';
import { SessionProvenanceStamper } from '../../../../../daemon/lib/session/provenance/stamper.ts';
import { WARDEN_LABEL } from '../../../../../daemon/lib/session/peers/warden-lifecycle.ts';
import { sessionConfig } from '../../../../support/daemon/storage.ts';

const NOW = '2026-11-08T10:00:00.000Z';
const CHILD = parseSessionId('mw7bp88g-c0000001');
const PARENT = parseSessionId('mw7bp88g-c0000002');
const ONE_OFF = parseSessionId('mw7bp88g-c0000004');
const GRANDPARENT = parseSessionId('mw7bp88g-c0000003');

/** A storage whose index and documents are exactly what the test says, and nothing else. */
function storage(
  indexed: readonly SessionId[],
  documents: ReadonlyMap<string, unknown>,
): Pick<DaemonStorage, 'listSessions' | 'readConfig'> {
  return {
    listSessions: () => indexed.map(id => ({ id, lastSequence: 0, journalLine: 0, journal: null })),
    readConfig: async id => documents.get(id) as Awaited<ReturnType<DaemonStorage['readConfig']>>,
  };
}

const ancestry = (
  indexed: readonly SessionId[],
  documents: ReadonlyMap<string, unknown>,
  registered: readonly RegisteredAncestor[] = [],
) => new StorageSessionAncestry(storage(indexed, documents), () => registered);

describe('the spawn ancestry snapshot proves every member, and refuses only a walk that reaches an unproven one', () => {
  test('an indexed ancestor the registry does not hold is still walked, so a warden grandparent shields the child', async () => {
    // Arrange: the registry holds only the parent; the grandparent warden is in the storage index alone
    const subject = ancestry(
      [PARENT, GRANDPARENT],
      new Map([
        [PARENT, sessionConfig(PARENT, { parent: GRANDPARENT })],
        [GRANDPARENT, sessionConfig(GRANDPARENT, { label: WARDEN_LABEL })],
      ]),
      [{ id: PARENT, label: 'team' }],
    );

    // Act
    const snapshot = await subject.snapshot();
    const stamped = new SessionProvenanceStamper({ now: () => NOW }).stamp(
      { id: CHILD, parent: PARENT, requestedByHuman: false },
      snapshot,
    );

    // Assert: the parent's label and parent are its document's, not the registry's
    expect(snapshot.get(PARENT)).toEqual({ id: PARENT, parent: GRANDPARENT });
    expect(stamped.provenance).toMatchObject({ wardenLineage: true, warden: GRANDPARENT });
  });

  test('an indexed ancestor whose document vanished by the strict read is refused when asked for', async () => {
    // Arrange
    const subject = ancestry([PARENT], new Map());

    // Act + Assert
    const snapshot = await subject.snapshot();
    expect(() => snapshot.get(PARENT)).toThrow(/disappeared while its spawn ancestry was being read/u);
  });

  test('an unreadable ancestor document is refused when asked for, never reads as "no stamp"', async () => {
    // Arrange
    const subject = new StorageSessionAncestry(
      {
        listSessions: () => [],
        readConfig: async () => {
          throw new Error('the state folder could not read this config');
        },
      },
      () => [{ id: PARENT }],
    );

    // Act + Assert
    const snapshot = await subject.snapshot();
    expect(() => snapshot.get(PARENT)).toThrow(/configuration could not be read/u);
  });

  test('a damaged ancestor document is refused when asked for, naming the session and quoting none of it', async () => {
    // Arrange
    const subject = ancestry(
      [PARENT],
      new Map([[PARENT, { ...sessionConfig(PARENT), label: 'FIXTURE_DAMAGE', provenance: { v: 99 } }]]),
    );

    // Act
    const snapshot = await subject.snapshot();
    let failure: Error | undefined;
    try {
      snapshot.get(PARENT);
    } catch (error) {
      failure = error as Error;
    }

    // Assert
    expect(failure?.message).toBe(
      `session ${PARENT}'s configuration is damaged, so its spawn ancestry cannot be proved`,
    );
    expect(failure?.message).not.toContain('FIXTURE_DAMAGE');
  });

  test('a registered ferret with no document is an ancestor with no stamp, as the registry knows it', async () => {
    // Arrange
    const subject = ancestry([], new Map(), [{ id: PARENT, label: 'team', parent: GRANDPARENT }]);

    // Act + Assert
    expect(await subject.snapshot()).toEqual(new Map([[PARENT, { id: PARENT, label: 'team', parent: GRANDPARENT }]]));
  });

  test('one damaged session off every walk is skipped and said once, so another ferret still starts', async () => {
    // Arrange: ONE_OFF is damaged and nobody descends from it; PARENT is a fine warden's child
    const reported: string[] = [];
    const subject = new StorageSessionAncestry(
      storage(
        [PARENT, GRANDPARENT, ONE_OFF],
        new Map([
          [PARENT, sessionConfig(PARENT, { parent: GRANDPARENT })],
          [GRANDPARENT, sessionConfig(GRANDPARENT, { label: WARDEN_LABEL })],
          [ONE_OFF, { ...sessionConfig(ONE_OFF), provenance: { v: 99 } }],
        ]),
      ),
      () => [],
      id => reported.push(id),
    );

    // Act
    const first = await subject.snapshot();
    await subject.snapshot();
    const stamped = new SessionProvenanceStamper({ now: () => NOW }).stamp(
      { id: CHILD, parent: PARENT, requestedByHuman: false },
      first,
    );

    // Assert: the start goes on and is still shielded; the bad one was reported once, not per snapshot
    expect(stamped.provenance).toMatchObject({ wardenLineage: true, warden: GRANDPARENT });
    expect(reported).toEqual([ONE_OFF]);
  });

  test('a start whose walk passes through the damaged session is still refused', async () => {
    // Arrange: PARENT is damaged; its own parent is a warden that would have shielded the child
    const subject = ancestry(
      [PARENT, GRANDPARENT],
      new Map([
        [PARENT, { ...sessionConfig(PARENT, { parent: GRANDPARENT }), provenance: { v: 99 } }],
        [GRANDPARENT, sessionConfig(GRANDPARENT, { label: WARDEN_LABEL })],
      ]),
    );

    // Act + Assert
    const snapshot = await subject.snapshot();
    expect(() =>
      new SessionProvenanceStamper({ now: () => NOW }).stamp(
        { id: CHILD, parent: PARENT, requestedByHuman: false },
        snapshot,
      ),
    ).toThrow(/is damaged/u);
  });
});
