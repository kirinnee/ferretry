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

describe('the spawn ancestry snapshot reads the whole fleet strictly', () => {
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

  test('an indexed ancestor whose document vanished by the strict read fails the snapshot', async () => {
    // Arrange
    const subject = ancestry([PARENT], new Map());

    // Act + Assert
    await expect(subject.snapshot()).rejects.toThrow(/disappeared while its spawn ancestry was being read/u);
  });

  test('an unreadable ancestor document fails the snapshot, never reads as "no stamp"', async () => {
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
    await expect(subject.snapshot()).rejects.toThrow(/could not read/u);
  });

  test('a damaged ancestor document fails the snapshot, naming the session and quoting none of it', async () => {
    // Arrange
    const subject = ancestry(
      [PARENT],
      new Map([[PARENT, { ...sessionConfig(PARENT), label: 'FIXTURE_DAMAGE', provenance: { v: 99 } }]]),
    );

    // Act
    const failure = await subject.snapshot().then(
      () => undefined,
      (error: unknown) => error as Error,
    );

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
});
