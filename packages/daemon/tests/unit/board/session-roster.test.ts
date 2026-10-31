import { describe, it } from 'bun:test';
import should from 'should';
import { StorageSessionRoster } from '../../../src/adapters/board/session-roster.ts';
import type { DocumentFreshness } from '../../../src/adapters/storage/session-storage.ts';
import { parseSessionId, type SessionId } from '../../../src/lib/session-id.ts';
import type { WardenLivenessLedger } from '../../../src/lib/warden/types.ts';

/**
 * The board roster's memo: what a pair of session documents says is parsed once per pair of values the
 * storage hands out, and never outlives them. The storage owns freshness — it hands out a new value when the
 * file changed, whoever changed it — so these tests stand in for it with documents swapped by hand.
 */

const EARLIER = '2026-10-30T09:00:00.000Z';
const LATER = '2026-10-30T09:59:00.000Z';

/** A storage of documents held in memory, recording how each was asked for and how often a state was looked into. */
class Documents {
  readonly configs = new Map<string, unknown>();
  readonly states = new Map<string, Record<string, unknown>>();
  readonly freshness: string[] = [];
  looks = 0;

  set(id: string, state: Record<string, unknown>, config: Record<string, unknown> = {}): void {
    this.configs.set(id, Object.freeze({ id, ...config }));
    // A proxy counts every look into the state: a memoized pair is never looked into again.
    this.states.set(
      id,
      new Proxy(Object.freeze({ id, ...state }), {
        get: (target, key) => {
          // Resolving a promise with the state asks it for `then`; that is not a look into the document.
          if (key !== 'then') this.looks += 1;
          return Reflect.get(target, key);
        },
      }),
    );
  }

  readonly storage = {
    listSessions: () =>
      [...this.states.keys()].map(id => ({ id: parseSessionId(id), lastSequence: 1, journalLine: 1, journal: null })),
    readConfig: async (id: SessionId, freshness?: DocumentFreshness) => {
      this.freshness.push(`config:${freshness ?? 'proved'}`);
      return this.configs.get(id) as never;
    },
    readState: async (id: SessionId, freshness?: DocumentFreshness) => {
      this.freshness.push(`state:${freshness ?? 'proved'}`);
      return this.states.get(id) as never;
    },
  };
}

describe('the board session roster memo', () => {
  it('should read both documents as a whole-fleet reader does, heard', async () => {
    // Arrange
    const documents = new Documents();
    documents.set('lead', { status: 'running' });

    // Act
    await new StorageSessionRoster(documents.storage, () => undefined).roster();

    // Assert
    should(documents.freshness.sort()).eql(['config:heard', 'state:heard']);
  });

  it('should not look into an unchanged pair of documents again', async () => {
    // Arrange
    const documents = new Documents();
    documents.set('lead', { status: 'running', lastActivityAt: EARLIER }, { focusTask: { id: 'F12' } });
    const roster = new StorageSessionRoster(documents.storage, () => undefined);
    const first = await roster.roster();
    const looked = documents.looks;

    // Act
    const second = await roster.roster();

    // Assert
    should(looked).be.above(0);
    should(documents.looks).equal(looked);
    should(second.sessions.get('lead')).eql(first.sessions.get('lead'));
  });

  it('should see a write made outside the daemon on the next read, once the storage hands out the new state', async () => {
    // Arrange
    const documents = new Documents();
    documents.set('lead', { status: 'running', lastActivityAt: EARLIER });
    const roster = new StorageSessionRoster(documents.storage, () => undefined);
    await roster.roster();

    // Act — an editor rewrote state.json; the storage's watch (or its stat) hands out a new value.
    documents.set('lead', { status: 'completed', lastActivityAt: LATER });
    const read = await roster.roster();

    // Assert
    should(read.sessions.get('lead')).eql({
      id: 'lead',
      status: 'completed',
      focusTask: null,
      declaredWait: false,
      lastActivityAt: LATER,
    });
  });

  it('should read the focus card again when only the configuration changed', async () => {
    // Arrange
    const documents = new Documents();
    documents.set('lead', { status: 'running' }, { focusTask: { id: 'F12' } });
    const roster = new StorageSessionRoster(documents.storage, () => undefined);
    await roster.roster();
    const state = documents.states.get('lead');

    // Act — a new configuration value beside the very same state value.
    documents.configs.set('lead', Object.freeze({ id: 'lead', focusTask: { id: 'F13' } }));
    should(documents.states.get('lead')).equal(state);
    const read = await roster.roster();

    // Assert
    should(read.sessions.get('lead')?.focusTask).eql({ id: 'F13' });
  });

  it("should lay the Warden's ledger over a memoized pair on every read, its subprocess window replacing the document's", async () => {
    // Arrange
    const documents = new Documents();
    documents.set('lead', { status: 'running', lastTranscriptAt: LATER, subprocessSince: EARLIER });
    let ledger: WardenLivenessLedger | undefined;
    const roster = new StorageSessionRoster(documents.storage, () => ledger);
    should((await roster.roster()).sessions.get('lead')?.subprocessSince).equal(EARLIER);

    // Act — the ledger now says the subprocess window closed, and that a token advanced.
    ledger = { lastTokenAdvanceAt: LATER };
    const read = await roster.roster();

    // Assert
    should(read.sessions.get('lead')).eql({
      id: 'lead',
      status: 'running',
      focusTask: null,
      declaredWait: false,
      lastTranscriptAt: LATER,
      lastTokenAdvanceAt: LATER,
    });
  });
});
