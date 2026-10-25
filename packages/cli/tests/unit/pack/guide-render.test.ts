import { describe, it } from 'bun:test';
import should from 'should';
import { renderCleanUp, renderInventory, renderTextDiff } from '../../../src/lib/pack/guide-render.ts';
import { INVENTORY, JOB, SUGGESTION } from './fixtures.ts';

const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const RESET = '\u001b[39m';

describe('renderTextDiff', () => {
  it('should mark removed words [-like this-] and added words {+like this+}, whitespace outside the marks', () => {
    // Arrange + Act
    const text = renderTextDiff('Use opus for plans.', 'Use claude-opus-5-5 for plans.', false);

    // Assert
    should(text).equal('Use [-opus-] {+claude-opus-5-5+} for plans.');
  });

  it('should tint removed text red and added text green, brackets kept, on a terminal', () => {
    // Arrange + Act
    const text = renderTextDiff('Use opus now', 'Use haiku now', true);

    // Assert
    should(text).equal(`Use ${RED}[-opus-]${RESET} ${GREEN}{+haiku+}${RESET} now`);
  });

  it('should show an unchanged prompt as itself', () => {
    // Arrange + Act + Assert
    should(renderTextDiff('Same words.', 'Same words.', true)).equal('Same words.');
  });

  it('should keep a changed run of several words in one mark', () => {
    // Arrange + Act
    const text = renderTextDiff('A one two B', 'A three B', false);

    // Assert
    should(text).equal('A [-one two-] {+three+} B');
  });

  it('should drop a removed blank and keep an added one, so a reflow marks nothing', () => {
    // Arrange + Act
    const text = renderTextDiff('A B', 'A\n\nB', false);

    // Assert
    should(text).equal('A\n\nB');
  });
});

describe('renderCleanUp', () => {
  it('should say who rewrote it, show the diff, the notes, and how to accept it', () => {
    // Arrange + Act
    const text = renderCleanUp({ ...JOB, status: 'suggested' }, SUGGESTION, 'foo', false);

    // Assert
    should(text.split('\n')).eql([
      'Cleaned up by claude-opus-5-5 on claude-work (2026-10-22 12:05Z). Removed text is [-like this-], added text is {+like this+}:',
      '',
      'Use [-opus-] {+claude-opus-5-5+} for plans. Use [-glm-] {+claude-haiku-5-5+} for chores.',
      '',
      'Notes (2):',
      '  - absent_model: glm-5 is not run by any runtime here',
      '  - suggestion: Add a Codex login for a second family.',
      '',
      'Accept with: foo guide accept run-1',
    ]);
  });

  it('should leave the notes out when there are none, and tint the diff on a terminal', () => {
    // Arrange + Act
    const text = renderCleanUp({ ...JOB, status: 'suggested' }, { ...SUGGESTION, notes: [] }, 'foo', true);

    // Assert
    should(text).not.containEql('Notes');
    should(text).containEql(`${RED}[-opus-]${RESET}`);
    should(text).containEql(`${GREEN}{+claude-opus-5-5+}${RESET}`);
  });
});

describe('renderCleanUp for a prompt that was written', () => {
  const written = { ...SUGGESTION, before: '', suggested: { ...SUGGESTION.suggested, mode: 'generate' as const } };

  it('should say who wrote it and show the new prompt plainly, with no diff marks', () => {
    // Arrange + Act
    const text = renderCleanUp({ ...JOB, mode: 'generate', status: 'suggested' }, written, 'foo', true);

    // Assert
    should(text.split('\n').slice(0, 3)).eql([
      'Written by claude-opus-5-5 on claude-work (2026-10-22 12:05Z):',
      '',
      SUGGESTION.after,
    ]);
    should(text).not.containEql('[-');
    should(text).not.containEql('\u001b');
    should(text).endWith('Accept with: foo guide accept run-1');
  });

  it('should still diff a prompt written over one the owner had', () => {
    // Arrange + Act
    const text = renderCleanUp(
      { ...JOB, mode: 'generate', status: 'suggested' },
      { ...written, before: 'Use opus.' },
      'foo',
      false,
    );

    // Assert
    should(text).startWith('Rewritten by claude-opus-5-5 on claude-work');
    should(text).containEql('{+');
  });
});

describe('renderInventory', () => {
  it('should list each runtime with its models, then each model with where it runs', () => {
    // Arrange + Act
    const text = renderInventory(INVENTORY);

    // Assert
    should(text.split('\n')).eql([
      'Runtimes (2):',
      '  ready  claude-work (claude, anthropic) · quota 5h 2% · wk 46%',
      '      models: claude-opus-5-5, claude-haiku-5-5',
      '  cannot codex-off (codex) · quota not measured — codex-off needs signing in.',
      '      models: (none)',
      '',
      'Models (3):',
      '  anthropic/claude-opus-5-5 — Claude Opus 5.5, best, 200000 context',
      '      runs on: claude-work',
      '  openai/gpt-6-astra (codex) — GPT-6 Astra, best',
      '      runs on: codex-off (cannot start now)',
      '  zai/glm-5 — GLM 5, fast',
      '      runs on: no runtime here',
    ]);
  });
});
