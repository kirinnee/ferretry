import { describe, expect, it } from 'bun:test';
import type { MachineSetupProgress } from '../../../../../src/features/fleet/setup/onboarding-model.ts';
import {
  browserSetupStorage,
  MACHINE_SETUP_PROGRESS_KEY,
  readMachineSetupProgress,
  readSetupProgress,
  SETUP_PROGRESS_KEY,
  writeMachineSetupProgress,
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
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
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

describe('new machine setup progress', () => {
  const RAIL: MachineSetupProgress = {
    at: 'warden',
    states: { pair: 'done', start: 'done', voice: 'skipped' },
    start: 'clone',
  };

  it('keeps one machine’s rail and gives it back to that machine only', () => {
    const storage = memory();
    writeMachineSetupProgress(storage, studio, RAIL);
    expect(readMachineSetupProgress(storage, studio)).toEqual(RAIL);
    expect(readMachineSetupProgress(storage, work)).toBeNull();
  });

  it('keeps the other machines’ rails when one is written', () => {
    const storage = memory();
    writeMachineSetupProgress(storage, work, { ...RAIL, at: 'logins' });
    writeMachineSetupProgress(storage, studio, RAIL);
    expect(readMachineSetupProgress(storage, work)?.at).toBe('logins');
    expect(readMachineSetupProgress(storage, studio)?.at).toBe('warden');
  });

  it('forgets one machine without touching another', () => {
    const storage = memory();
    writeMachineSetupProgress(storage, studio, RAIL);
    writeMachineSetupProgress(storage, work, { ...RAIL, at: 'done' });
    writeMachineSetupProgress(storage, studio, null);
    expect(readMachineSetupProgress(storage, studio)).toBeNull();
    expect(readMachineSetupProgress(storage, work)?.at).toBe('done');
  });

  it('keeps the rail apart from the first run’s own progress', () => {
    const storage = memory();
    writeSetupProgress(storage, studio, PROGRESS);
    writeMachineSetupProgress(storage, studio, RAIL);
    expect(readSetupProgress(storage, studio)).toEqual(PROGRESS);
    expect(readMachineSetupProgress(storage, studio)).toEqual(RAIL);
  });

  it('reads an unreadable value as nothing kept, never as an error', () => {
    expect(readMachineSetupProgress(memory({ [MACHINE_SETUP_PROGRESS_KEY]: '{not json' }), studio)).toBeNull();
    expect(readMachineSetupProgress(memory(), studio)).toBeNull();
  });

  it('reads a hand-edited value as nothing kept', () => {
    const edited = (value: unknown) => memory({ [MACHINE_SETUP_PROGRESS_KEY]: JSON.stringify({ studio: value }) });
    expect(readMachineSetupProgress(edited({ at: 'warden', states: {} }), studio)).toBeNull();
    expect(readMachineSetupProgress(edited({ at: 'warden', states: {}, start: 'borrowed' }), studio)).toBeNull();
    expect(
      readMachineSetupProgress(edited({ at: 'warden', states: { voice: 'finished' }, start: 'fresh' }), studio),
    ).toBeNull();
  });

  it('rejects a step id it does not know, as the open step and as a marked one', () => {
    const edited = (value: unknown) => memory({ [MACHINE_SETUP_PROGRESS_KEY]: JSON.stringify({ studio: value }) });
    expect(readMachineSetupProgress(edited({ at: 'billing', states: {}, start: 'fresh' }), studio)).toBeNull();
    expect(
      readMachineSetupProgress(edited({ at: 'warden', states: { billing: 'done' }, start: 'fresh' }), studio),
    ).toBeNull();
    expect(
      readMachineSetupProgress(edited({ at: 'warden', states: { done: 'done' }, start: 'fresh' }), studio),
    ).toBeNull();
  });

  it('still works when storage refuses a write', () => {
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => writeMachineSetupProgress(full, studio, RAIL)).not.toThrow();
  });
});
