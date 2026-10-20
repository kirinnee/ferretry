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
    should(text).containEql('app  /work/app:');
    should(text).containEql('other  /work/other:');
    should(text).containEql('[claude]  c-1  ');
    should(text).containEql('Fix login … Fixed it, thanks');
    should(text).containEql('unknown model');
  });

  it('should lead a named conversation with its name, then the first message, and drop the latest', () => {
    // Arrange
    const rows = [
      conversation({ id: 'c-1', name: 'Login page fix', preview: 'Fix login', latest: 'Fixed it' }),
      conversation({ id: 'c-2', name: 'Quiet one', preview: '' }),
    ];

    // Act
    const text = renderImportListing(listing(rows), 'fy');

    // Assert
    should(text).containEql('Login page fix — Fix login');
    should(text).not.containEql('Fixed it');
    should(text).containEql('Quiet one');
    should(text).not.containEql('Quiet one —');
  });

  it('should mark an already-adopted row and the limit and skipped counts', () => {
    // Arrange
    const rows = [conversation({ id: 'c-1', adoptedBy: 's-1' })];

    // Act
    const text = renderImportListing(listing(rows, { matched: 5, skipped: 2 }), 'fy');

    // Assert
    should(text).containEql('[claude] [ferret s-1]  c-1  ');
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
      '1) [claude]  app  2026-10-10T00:00:00.000Z  Fix the login page',
      '2) [codex]  other  2026-10-10T00:00:00.000Z  Fix the login page',
    ]);
  });

  it('should lead a named row with its name', () => {
    // Act
    const text = renderSearchMatches([conversation({ name: 'Login page fix' })]);

    // Assert
    should(text).equal('1) [claude]  app  2026-10-10T00:00:00.000Z  Login page fix — Fix the login page');
  });

  it('should tag a throwaway folder scratch, by its own name when a person chose one', () => {
    // Act
    const text = renderSearchMatches([
      conversation({ project: '/tmp/claude-1000/-work-app/d711c5af-2c1e-4b7a-9d3e-0f6a1b2c3d4e/scratchpad' }),
      conversation({ project: '/tmp/wt-cart' }),
    ]);

    // Assert
    should(text.split('\n')).eql([
      '1) [claude]  [scratch]  2026-10-10T00:00:00.000Z  Fix the login page',
      '2) [claude]  [scratch] wt-cart  2026-10-10T00:00:00.000Z  Fix the login page',
    ]);
  });
});
