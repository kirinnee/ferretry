import { describe, expect, it } from 'bun:test';
import {
  browserSetupStorage,
  readSetupProgress,
  SETUP_PROGRESS_KEY,
  writeSetupProgress,
} from '../../../../../src/features/fleet/setup/setup-progress.ts';
import { daemonId } from '../../../../../src/lib/daemon-connection.ts';
import '../../../../support/dom.ts';

const studio = daemonId('studio');
const work = daemonId('work');

const memory = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
};

const PROGRESS = {
  at: 'codex',
  answers: { choices: { claude: 'import' as const }, names: { claude: 'claude-mine' }, make: {}, accepted: [] },
};

describe('setup progress', () => {
  it('keeps one machine’s step and answers, and gives them back to that machine only', () => {
    const storage = memory();
    writeSetupProgress(storage, studio, PROGRESS);
    expect(readSetupProgress(storage, studio)).toEqual(PROGRESS);
    expect(readSetupProgress(storage, work)).toBeNull();
  });

  it('forgets one machine without touching another', () => {
    const storage = memory();
    writeSetupProgress(storage, studio, PROGRESS);
    writeSetupProgress(storage, work, { ...PROGRESS, at: 'claude' });
    writeSetupProgress(storage, studio, null);
    expect(readSetupProgress(storage, studio)).toBeNull();
    expect(readSetupProgress(storage, work)?.at).toBe('claude');
  });

  it('reads an unreadable or hand-edited value as nothing kept, never as an error', () => {
    expect(readSetupProgress(memory({ [SETUP_PROGRESS_KEY]: '{not json' }), studio)).toBeNull();
    expect(readSetupProgress(memory({ [SETUP_PROGRESS_KEY]: '{"studio":{"at":""}}' }), studio)).toBeNull();
    expect(readSetupProgress(memory(), studio)).toBeNull();
  });

  it('still works when storage refuses a write', () => {
    const full = { getItem: () => null, setItem: () => {
      throw new Error('QuotaExceededError');
    } };
    expect(() => writeSetupProgress(full, studio, PROGRESS)).not.toThrow();
  });

  it('reaches the browser’s storage, or says there is none', () => {
    expect(browserSetupStorage()).toBe(window.localStorage);
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('blocked');
      },
    });
    try {
      expect(browserSetupStorage()).toBeNull();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
