import { describe, expect, it } from 'bun:test';
import { installedCount, localNote, modelDetailWords, sizeWords, tileWords } from '../../src/lib/local-models.ts';
import { GPT_OSS, localModelsFixture, PULL, QWEN } from '../support/local-models.ts';

describe('sizeWords', () => {
  it('prints a size the way Ollama does, in decimal units', () => {
    expect(sizeWords(0)).toBe('0 B');
    expect(sizeWords(512)).toBe('512 B');
    expect(sizeWords(1_500)).toBe('1.5 KB');
    expect(sizeWords(274_000_000)).toBe('274 MB');
    expect(sizeWords(13_800_000_000)).toBe('13.8 GB');
    expect(sizeWords(2_000_000_000)).toBe('2 GB');
    expect(sizeWords(2_400_000_000_000)).toBe('2.4 TB');
    expect(sizeWords(5_000_000_000_000_000)).toBe('5000 TB');
  });
});

describe('modelDetailWords', () => {
  it('joins what is known, and says nothing when nothing is', () => {
    expect(modelDetailWords(GPT_OSS)).toBe('20.9B · MXFP4 · 13.8 GB');
    expect(modelDetailWords(QWEN)).toBe('18.6 GB');
    expect(modelDetailWords({ id: 'x', label: 'x' })).toBe('');
  });
});

describe('tileWords', () => {
  const read = (snapshot: ReturnType<typeof localModelsFixture> | null, over = {}) => ({
    snapshot,
    checking: false,
    error: null,
    ...over,
  });

  it('counts the models that are installed', () => {
    expect(tileWords(read(localModelsFixture('found')))).toEqual({ text: '2 models installed', tone: 'ok' });
    expect(tileWords(read(localModelsFixture('found', { models: [GPT_OSS] })))).toEqual({
      text: '1 model installed',
      tone: 'ok',
    });
    expect(installedCount(3)).toBe('3 models installed');
  });

  it('names every state that is not "found" in a few words', () => {
    expect(tileWords(read(localModelsFixture('not-running')))?.text).toBe('Not running');
    expect(tileWords(read(localModelsFixture('none-pulled')))?.text).toBe('No model pulled yet');
    expect(tileWords(read(localModelsFixture('unreadable')))?.text).toBe('Not answering as Ollama');
    expect(tileWords(read(localModelsFixture('refused')))?.text).toBe('Address is not this machine');
    expect(tileWords(read(localModelsFixture('disabled')))).toEqual({
      text: 'Detection is switched off',
      tone: 'muted',
    });
  });

  it('says it is checking, says it could not, or says nothing before the first read', () => {
    expect(tileWords(read(null, { checking: true }))).toEqual({ text: 'Checking Ollama…', tone: 'muted' });
    expect(tileWords(read(null, { error: 'offline' }))).toEqual({ text: 'Could not check Ollama', tone: 'warn' });
    expect(tileWords(read(null))).toBeNull();
  });

  it('keeps the last answer on screen while it is asked again', () => {
    expect(tileWords(read(localModelsFixture('not-running'), { checking: true }))?.text).toBe('Not running');
  });
});

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
