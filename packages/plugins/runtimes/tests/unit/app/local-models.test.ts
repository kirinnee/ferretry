import { describe, expect, it } from 'bun:test';
import { localNote } from '../../../app/lib/local-models.ts';
import { localModelsFixture, PULL } from './support/local-models.ts';

describe('localNote', () => {
  it('has nothing to say when models were found, or nothing has been read', () => {
    expect(localNote(localModelsFixture('found'))).toBeNull();
    expect(localNote(null)).toBeNull();
    expect(localNote(undefined)).toBeNull();
  });

  it('gives the command its own line, so the sentence stops before it', () => {
    expect(localNote(localModelsFixture('none-pulled'))).toEqual({
      state: 'none-pulled',
      message: 'Ollama is running, but no model is installed yet.',
      command: PULL,
    });
  });

  it('keeps a sentence whole when it does not end in the command, and when it is only the command', () => {
    expect(localNote(localModelsFixture('not-running'))?.command).toBe(PULL);
    expect(localNote(localModelsFixture('not-running'))?.message).toContain('Start it');
    expect(localNote(localModelsFixture('none-pulled', { message: PULL }))?.message).toBe(PULL);
    expect(localNote(localModelsFixture('none-pulled', { message: `Run: ${PULL}` }))?.message).toBe(`Run: ${PULL}`);
  });

  it('shows no command for a state where typing one cannot help', () => {
    for (const state of ['unreadable', 'refused', 'disabled'] as const) {
      const note = localNote(localModelsFixture(state));
      expect(note?.command).toBeNull();
      expect(note?.message).toBe(localModelsFixture(state).message);
    }
  });
});
