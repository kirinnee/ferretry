import { describe, expect, it } from 'bun:test';
import type { MachineSetupProgress } from '../../../../../src/features/fleet/setup/onboarding-model.ts';
import {
  browserSetupStorage,
  MACHINE_SETUP_PROGRESS_KEY,
  readMachineSetupProgress,
  writeMachineSetupProgress,
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

const edited = (value: unknown) => memory({ [MACHINE_SETUP_PROGRESS_KEY]: JSON.stringify({ studio: value }) });

describe('new machine setup progress', () => {
  const RAIL: MachineSetupProgress = {
    at: 'warden',
    states: { pair: 'done', start: 'done', voice: 'skipped' },
    start: 'clone',
  };

  it('keeps its place under a version 2 key, so a place kept by the old Logins rail is not resumed', () => {
    expect(MACHINE_SETUP_PROGRESS_KEY).toBe('fy-onboarding-progress-v2');
    const storage = memory({ 'fy-onboarding-progress': JSON.stringify({ studio: RAIL }) });
    expect(readMachineSetupProgress(storage, studio)).toBeNull();
  });

  it('keeps one machine’s rail and gives it back to that machine only', () => {
    const storage = memory();
    writeMachineSetupProgress(storage, studio, RAIL);
    expect(readMachineSetupProgress(storage, studio)).toEqual(RAIL);
    expect(readMachineSetupProgress(storage, work)).toBeNull();
    expect([...storage.values.keys()]).toEqual([MACHINE_SETUP_PROGRESS_KEY]);
  });

  it('keeps the other machines’ rails when one is written', () => {
    const storage = memory();
    writeMachineSetupProgress(storage, work, { ...RAIL, at: 'claude' });
    writeMachineSetupProgress(storage, studio, RAIL);
    expect(readMachineSetupProgress(storage, work)?.at).toBe('claude');
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

  it('keeps the runtime names, the update ticks and the also-add choice typed on each CLI’s step', () => {
    const storage = memory();
    const answered: MachineSetupProgress = {
      ...RAIL,
      at: 'codex',
      states: { pair: 'done', claude: 'done', codex: 'skipped' },
      answers: {
        claude: { name: 'claude-mine', addAnother: true, accepted: ['skills', 'mcp'] },
        codex: { name: 'codex-2' },
      },
    };
    writeMachineSetupProgress(storage, studio, answered);
    expect(readMachineSetupProgress(storage, studio)).toEqual(answered);
  });

  it('reads a rail kept without answers, and answers for one CLI only', () => {
    expect(
      readMachineSetupProgress(edited({ at: 'claude', states: {}, start: 'fresh' }), studio)?.answers,
    ).toBeUndefined();
    const one = edited({ at: 'claude', states: {}, start: 'fresh', answers: { claude: {} } });
    expect(readMachineSetupProgress(one, studio)?.answers).toEqual({ claude: {} });
  });

  it('reads an unreadable value as nothing kept, never as an error', () => {
    expect(readMachineSetupProgress(memory({ [MACHINE_SETUP_PROGRESS_KEY]: '{not json' }), studio)).toBeNull();
    expect(readMachineSetupProgress(memory(), studio)).toBeNull();
  });

  it('reads a hand-edited value as nothing kept', () => {
    expect(readMachineSetupProgress(edited({ at: 'warden', states: {} }), studio)).toBeNull();
    expect(readMachineSetupProgress(edited({ at: 'warden', states: {}, start: 'borrowed' }), studio)).toBeNull();
    expect(
      readMachineSetupProgress(edited({ at: 'warden', states: { voice: 'finished' }, start: 'fresh' }), studio),
    ).toBeNull();
  });

  it('reads hand-edited answers as nothing kept', () => {
    const answers = (value: unknown) => edited({ at: 'claude', states: {}, start: 'fresh', answers: value });
    expect(readMachineSetupProgress(answers({ gemini: { name: 'x' } }), studio)).toBeNull();
    expect(readMachineSetupProgress(answers({ claude: { name: 7 } }), studio)).toBeNull();
    expect(readMachineSetupProgress(answers({ claude: { addAnother: 'yes' } }), studio)).toBeNull();
    expect(readMachineSetupProgress(answers({ claude: { accepted: [1] } }), studio)).toBeNull();
  });

  it('rejects a step id it does not know, as the open step and as a marked one', () => {
    expect(readMachineSetupProgress(edited({ at: 'billing', states: {}, start: 'fresh' }), studio)).toBeNull();
    expect(readMachineSetupProgress(edited({ at: 'logins', states: {}, start: 'fresh' }), studio)).toBeNull();
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

describe('browser storage', () => {
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
