import { afterEach, describe, test } from 'bun:test';
import should from 'should';
import {
  addReferenceMessage,
  addReferenceToComposer,
  composeReferenceDraft,
  draftCarriesReference,
  referenceToken,
} from '../../src/lib/composer-references.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { registerComposerQuoteTarget } from '../../src/lib/quote.ts';
import type { Reference } from '../../src/lib/references.ts';

const scopeA: DaemonSessionScope = { daemonId: 'daemon-a' as DaemonId, sessionId: 'sess-1' };
const scopeB: DaemonSessionScope = { daemonId: 'daemon-b' as DaemonId, sessionId: 'sess-1' };
const TERMINAL = 'a1b2c3d4e5f6';
const surface: Reference = { kind: 'surface', surface: 'terminal', key: TERMINAL };
const token = `%terminal:${TERMINAL}`;

const disposers: (() => void)[] = [];

/** A mounted composer for one scope, with the draft it currently holds. */
const composer = (scope: DaemonSessionScope, initial = '') => {
  const state = { draft: initial };
  disposers.push(
    registerComposerQuoteTarget({
      ...scope,
      draft: () => state.draft,
      replaceDraft: next => {
        state.draft = next;
      },
    }),
  );
  return state;
};

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

describe('referenceToken', () => {
  test('should render a canonical token and refuse what the grammar rejects', () => {
    // Assert
    should(referenceToken(surface)).equal(token);
    should(referenceToken({ kind: 'task', id: 'f12' })).equal('&F12');
    should(referenceToken({ kind: 'task', id: 'f12', sessionId: 'Session_A-1' })).equal('&F12@{Session_A-1}');
    should(referenceToken({ kind: 'surface', surface: 'terminal', key: 'bad key' })).be.null();
    should(referenceToken({ kind: 'task', id: 'F12', sessionId: '..' })).be.null();
  });
});

describe('composeReferenceDraft', () => {
  test('should start a draft with the token and leave room to keep typing', () => {
    // Assert
    should(composeReferenceDraft('', token)).equal(`${token} `);
    should(composeReferenceDraft('   ', token)).equal(`${token} `);
  });

  test('should append after an existing sentence without clobbering it', () => {
    // Assert
    should(composeReferenceDraft('run the build in', token)).equal(`run the build in ${token} `);
    should(composeReferenceDraft('run the build in   ', token)).equal(`run the build in ${token} `);
  });
});

describe('draftCarriesReference', () => {
  test('should recognise the same surface however it was written', () => {
    // Assert
    should(draftCarriesReference(`watch ${token} please`, surface)).be.true();
    should(draftCarriesReference(`watch %TERMINAL:${TERMINAL}`, surface)).be.true();
  });

  test('should not confuse a different surface or a welded token for this one', () => {
    // Assert
    should(draftCarriesReference('watch %terminal:0f0e0d0c0b0a', surface)).be.false();
    should(draftCarriesReference(`watch x${token}`, surface)).be.false();
    should(draftCarriesReference('', surface)).be.false();
  });

  test('should answer false for a reference the grammar cannot write down', () => {
    // Assert
    should(draftCarriesReference(token, { kind: 'surface', surface: 'terminal', key: 'bad key' })).be.false();
  });

  test('should compare task duplicates by their effective target in the composer scope', () => {
    // Assert — bare self and explicitly-qualified self are one target.
    should(draftCarriesReference('work on &F12', { kind: 'task', id: 'F12', sessionId: 'sess-1' }, scopeA)).be.true();
    should(draftCarriesReference('work on &F12@{sess-1}', { kind: 'task', id: 'F12' }, scopeA)).be.true();

    // Foreign neighbours, including the same id, remain distinct.
    should(draftCarriesReference('work on &F12', { kind: 'task', id: 'F12', sessionId: 'sess-2' }, scopeA)).be.false();
    should(
      draftCarriesReference('work on &F12@{sess-2}', { kind: 'task', id: 'F12', sessionId: 'sess-3' }, scopeA),
    ).be.false();
    should(
      draftCarriesReference('work on &f12@{Session_A}', { kind: 'task', id: 'F12', sessionId: 'Session_A' }, scopeA),
    ).be.true();
    should(
      draftCarriesReference('work on &F12@{Session_A}', { kind: 'task', id: 'F12', sessionId: 'session_a' }, scopeA),
    ).be.false();
    should(draftCarriesReference('welded x&F12@{sess-1}', { kind: 'task', id: 'F12' }, scopeA)).be.false();
  });
});

describe('addReferenceToComposer', () => {
  test('should deliver the token into the composer for exactly that scope', () => {
    // Arrange
    const state = composer(scopeA, 'type this in');

    // Act
    const outcome = addReferenceToComposer(surface, scopeA);

    // Assert
    should(outcome).equal('added');
    should(state.draft).equal(`type this in ${token} `);
  });

  test('should never deliver one daemon surface into another daemon composer', () => {
    // Arrange — same session id, different daemon.
    const other = composer(scopeB, 'other daemon draft');

    // Act
    const outcome = addReferenceToComposer(surface, scopeA);

    // Assert
    should(outcome).equal('no-composer');
    should(other.draft).equal('other daemon draft');
  });

  test('should refuse to repeat a reference the draft already carries', () => {
    // Arrange
    const state = composer(scopeA, `already ${token} here`);

    // Act
    const outcome = addReferenceToComposer(surface, scopeA);

    // Assert
    should(outcome).equal('duplicate');
    should(state.draft).equal(`already ${token} here`);
  });

  test('should treat a bare-self and qualified-self task as one composer target', () => {
    // Arrange
    const bare = composer(scopeA, 'already &F12 here');

    // Act & Assert
    should(addReferenceToComposer({ kind: 'task', id: 'F12', sessionId: 'sess-1' }, scopeA)).equal('duplicate');
    should(bare.draft).equal('already &F12 here');
  });

  test('should append a foreign qualified task to the viewer composer only', () => {
    // Arrange
    const viewer = composer(scopeA, 'compare');
    const otherDaemon = composer(scopeB, 'untouched');

    // Act
    const outcome = addReferenceToComposer({ kind: 'task', id: 'f12', sessionId: 'sess-2' }, scopeA);

    // Assert
    should(outcome).equal('added');
    should(viewer.draft).equal('compare &F12@{sess-2} ');
    should(otherDaemon.draft).equal('untouched');
  });

  test('should say so when no composer is mounted for the session', () => {
    // Assert
    should(addReferenceToComposer(surface, scopeA)).equal('no-composer');
  });

  test('should refuse a reference the grammar cannot write down', () => {
    // Arrange
    const state = composer(scopeA, 'untouched');

    // Act
    const outcome = addReferenceToComposer({ kind: 'surface', surface: 'terminal', key: 'bad key' }, scopeA);

    // Assert
    should(outcome).equal('rejected');
    should(state.draft).equal('untouched');
  });

  test('should reject an unsafe qualified task without touching the viewer draft', () => {
    // Arrange
    const state = composer(scopeA, 'untouched');

    // Act
    const outcome = addReferenceToComposer({ kind: 'task', id: 'F12', sessionId: '..' }, scopeA);

    // Assert
    should(outcome).equal('rejected');
    should(state.draft).equal('untouched');
  });
});

describe('addReferenceMessage', () => {
  test('should report every outcome in one voice', () => {
    // Assert
    should(addReferenceMessage('added', token)).containEql(token);
    should(addReferenceMessage('duplicate', token)).containEql('already in this message');
    should(addReferenceMessage('no-composer', token)).containEql('nowhere to add it');
    should(addReferenceMessage('rejected', token)).containEql('cannot be written down');
  });
});
