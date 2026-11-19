import { describe, expect, it } from 'bun:test';
import {
  readStepperMemory,
  type StepperStorage,
  stepperKey,
  writeStepperMemory,
} from '../../../app/features/stepper/stepper-memory.ts';

const memoryStore = (): StepperStorage & { readonly map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) };
};
const FACTS = { passkey: true, name: false, setup: undefined, project: false } as const;

describe('what the device remembers of the stepper', () => {
  it('keys it per machine under the onboarding owner', () => {
    expect(stepperKey('d1')).toBe('fy:onboarding:stepper:d1');
    expect(stepperKey('d1')).not.toBe(stepperKey('d2'));
  });

  it('gives back the facts and the dismissal it was given, an unknown fact staying unknown', () => {
    const store = memoryStore();
    writeStepperMemory(store, 'd1', { facts: FACTS, dismissed: true, seenOpen: true });
    expect(readStepperMemory(store, 'd1')).toEqual({ facts: FACTS, dismissed: true, seenOpen: true });
    expect(readStepperMemory(store, 'd2')).toBeUndefined();
  });

  it('never remembers a locked wait as an answer, and reads an old record with no seenOpen as never seen open', () => {
    const store = memoryStore();
    writeStepperMemory(store, 'd1', { facts: { ...FACTS, name: 'locked' }, dismissed: false, seenOpen: false });
    expect(readStepperMemory(store, 'd1')?.facts.name).toBeUndefined();
    store.map.set(stepperKey('d2'), '{"format":3,"facts":{"passkey":true},"dismissed":false}');
    expect(readStepperMemory(store, 'd2')?.seenOpen).toBe(false);
  });

  it('reads damaged, foreign or wrong-format (including the older two-tool format 2) storage as nothing remembered', () => {
    for (const raw of [
      '{',
      'null',
      '[]',
      '{"format":4,"facts":{}}',
      '{"format":3,"facts":{"name":"yes"}}',
      '{"format":2,"facts":{"claude":true,"codex":true}}',
      '{"format":1,"facts":{"login":true}}',
    ]) {
      const store = memoryStore();
      store.map.set(stepperKey('d1'), raw);
      expect(readStepperMemory(store, 'd1')).toBeUndefined();
    }
  });

  it('survives storage that refuses', () => {
    const refusing: StepperStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => writeStepperMemory(refusing, 'd1', { facts: FACTS, dismissed: false, seenOpen: false })).not.toThrow();
    expect(readStepperMemory(refusing, 'd1')).toBeUndefined();
    expect(readStepperMemory(undefined, 'd1')).toBeUndefined();
  });
});
