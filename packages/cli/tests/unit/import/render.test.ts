import { describe, it } from 'bun:test';
import should from 'should';
import { renderAdoptResult, renderImportListing, renderSearchMatches } from '../../../src/lib/import/render.ts';
import { conversation, listing } from './fixtures.ts';

describe('renderImportListing', () => {
  it('should say so and how to adopt when nothing matched', () => {
    // Act
    const text = renderImportListing(listing([]), 'fy');

    // Assert
    should(text).containEql('No conversations matched');
    should(text).containEql('fy import conversations --select');
  });

  it('should group rows by project folder and show the latest message when it differs', () => {
    // Arrange
    const rows = [
      conversation({ id: 'c-1', project: '/work/app', preview: 'Fix login', latest: 'Fixed it, thanks' }),
      conversation({ id: 'c-2', project: '/work/other', model: undefined }),
    ];

    // Act
    const text = renderImportListing(listing(rows), 'fy');

    // Assert
    should(text).containEql('/work/app:');
    should(text).containEql('/work/other:');
    should(text).containEql('Fix login … Fixed it, thanks');
    should(text).containEql('unknown model');
  });

  it('should mark an already-adopted row and the limit and skipped counts', () => {
    // Arrange
    const rows = [conversation({ id: 'c-1', adoptedBy: 's-1' })];

    // Act
    const text = renderImportListing(listing(rows, { matched: 5, skipped: 2 }), 'fy');

    // Assert
    should(text).containEql('kept as s-1');
    should(text).containEql('showing 1 of 5 matched');
    should(text).containEql('2 file(s)');
  });
});

describe('renderAdoptResult', () => {
  it('should say there is nothing to adopt', () => {
    // Act + Assert
    should(renderAdoptResult({ adopted: [], refused: [] })).equal('nothing to adopt');
  });

  it('should render one line per adopted and refused conversation', () => {
    // Act
    const text = renderAdoptResult({
      adopted: [{ id: 'c-1', session: 's-1', name: 'Fable', status: 'running' }],
      refused: [{ id: 'c-2', code: 'not_found', reason: 'not found in the listing on this machine' }],
    });

    // Assert
    should(text).containEql('adopted  c-1  Fable  (s-1)  — running');
    should(text).containEql('refused  c-2  — not found in the listing on this machine');
  });
});

describe('renderSearchMatches', () => {
  it('should number every row with its project, harness and preview', () => {
    // Act
    const text = renderSearchMatches([
      conversation({ id: 'c-1', project: '/work/app' }),
      conversation({ id: 'c-2', project: '/work/other', harness: 'codex' }),
    ]);

    // Assert
    should(text.split('\n')).eql([
      '1) /work/app  claude  2026-10-10T00:00:00.000Z  Fix the login page',
      '2) /work/other  codex  2026-10-10T00:00:00.000Z  Fix the login page',
    ]);
  });
});
