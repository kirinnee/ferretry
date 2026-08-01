import { describe, it } from 'bun:test';
import should from 'should';
import { DONE_MARKER_FILENAME, doneMarkerCertifiesTurn } from '../../../src/lib/warden/index.ts';

const marker = (turn: number): string => JSON.stringify({ at: '2026-07-31T12:00:00.000Z', type: 'done', turn });

describe('the done marker filename', () => {
  it('should be the exact name the writer and the revive already agree on', () => {
    // Arrange / Act / Assert
    should(DONE_MARKER_FILENAME).equal('done.marker');
  });
});

describe('reading a done marker', () => {
  it('should certify the turn it names', () => {
    // Arrange / Act / Assert
    should(doneMarkerCertifiesTurn(marker(3), 3)).be.true();
  });

  it('should refuse a marker left by an earlier turn', () => {
    // Arrange: the stale-marker bug the turn field exists to prevent.
    should(doneMarkerCertifiesTurn(marker(2), 3)).be.false();
  });

  it('should refuse a marker ahead of the turn the session is on', () => {
    // Arrange: the two disagree about what is current, and disagreement is not evidence.
    should(doneMarkerCertifiesTurn(marker(4), 3)).be.false();
  });

  it.each([
    { label: 'no marker at all', document: undefined },
    { label: 'an empty file', document: '' },
    { label: 'a whitespace-only file', document: '  \n ' },
    { label: 'a torn write', document: '{"at":"2026-07-31T12:00:00.000Z","ty' },
    { label: 'a marker of another type', document: JSON.stringify({ at: 'x', type: 'help', turn: 3 }) },
    { label: 'a marker with no turn', document: JSON.stringify({ at: 'x', type: 'done' }) },
    { label: 'a marker whose turn is not a number', document: JSON.stringify({ at: 'x', type: 'done', turn: '3' }) },
    { label: 'a marker with no instant', document: JSON.stringify({ type: 'done', turn: 3 }) },
    { label: 'a JSON array', document: '[]' },
  ])('should refuse $label, so the session is looked at rather than skipped', ({ document }) => {
    // Arrange / Act / Assert
    should(doneMarkerCertifiesTurn(document, 3)).be.false();
  });

  it('should certify turn zero, which is a real turn', () => {
    // Arrange / Act / Assert
    should(doneMarkerCertifiesTurn(marker(0), 0)).be.true();
  });
});
