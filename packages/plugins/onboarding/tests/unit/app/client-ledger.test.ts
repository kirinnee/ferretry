import { describe, expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import {
  CLIENT_LEDGER_KEY,
  EMPTY_LEDGER,
  isClientStepSet,
  type LedgerStorage,
  readLedger,
  recordClientStep,
  withClientStep,
} from '../../../app/lib/client-ledger.ts';

const AT = '2026-11-19T09:00:00.000Z' as Instant;
const LATER = '2026-11-19T10:00:00.000Z' as Instant;
const KEY = CLIENT_LEDGER_KEY;

function memory(initial?: string): LedgerStorage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>(initial === undefined ? [] : [[KEY, initial]]);
  return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) };
}

describe('the device ledger', () => {
  test("lives under one app key, named by the shell's storage table", () => {
    expect(KEY).toBe('fy:onboarding:client');
  });

  test('nothing stored reads as empty; no storage reads as empty', () => {
    expect(readLedger(memory())).toEqual(EMPTY_LEDGER);
    expect(readLedger(undefined)).toEqual(EMPTY_LEDGER);
  });

  test('a step recorded for one daemon is set for the device; daemons accumulate once each', () => {
    const storage = memory();
    expect(recordClientStep(storage, 'layouts', 'layout', 'daemon-a', AT)).toBe(true);
    expect(recordClientStep(storage, 'layouts', 'layout', 'daemon-b', LATER)).toBe(true);
    expect(recordClientStep(storage, 'layouts', 'layout', 'daemon-b', LATER)).toBe(true);
    const ledger = readLedger(storage);
    expect(isClientStepSet(ledger, 'layouts', 'layout')).toBe(true);
    expect(isClientStepSet(ledger, 'layouts', 'density')).toBe(false);
    expect(ledger.steps['layouts.layout']).toEqual({ at: LATER, daemons: ['daemon-a', 'daemon-b'] });
  });

  test('withClientStep is pure: the ledger it was given is unchanged', () => {
    const before = withClientStep(EMPTY_LEDGER, 'voice', 'voice', 'a', AT);
    const after = withClientStep(before, 'voice', 'speedups', 'a', AT);
    expect(Object.keys(before.steps)).toEqual(['voice.voice']);
    expect(Object.keys(after.steps)).toEqual(['voice.voice', 'voice.speedups']);
    expect(Object.keys(EMPTY_LEDGER.steps)).toEqual([]);
  });

  test('damaged, foreign-format and oversized storage reads as empty; it never throws', () => {
    for (const raw of [
      'not json',
      '{"format":2,"steps":{}}',
      '{"format":1,"steps":{"Bad Key":{"at":"2026-11-19T09:00:00.000Z","daemons":[]}}}',
      '{"format":1,"steps":{"a.b":{"at":"yesterday","daemons":[]}}}',
      '{"format":1,"steps":{"a.b":{"at":"2026-11-19T09:00:00.000Z","daemons":[],"extra":1}}}',
      '[]',
      'null',
    ]) {
      expect(readLedger(memory(raw))).toEqual(EMPTY_LEDGER);
    }
  });

  test('a throwing or full storage reports false and loses nothing silently', () => {
    const full: LedgerStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(recordClientStep(full, 'a', 'b', 'd', AT)).toBe(false);
    expect(recordClientStep(undefined, 'a', 'b', 'd', AT)).toBe(false);
    const blocked: LedgerStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
    };
    expect(readLedger(blocked)).toEqual(EMPTY_LEDGER);
  });

  test('holds only keys, instants and daemon ids: nothing a person typed', () => {
    const storage = memory();
    recordClientStep(storage, 'onboarding', 'appearance', 'fy_daemon_x', AT);
    expect(JSON.parse(storage.map.get(KEY) ?? '')).toEqual({
      format: 1,
      steps: { 'onboarding.appearance': { at: AT, daemons: ['fy_daemon_x'] } },
    });
  });

  test('an invalid step key is not written', () => {
    expect(withClientStep(EMPTY_LEDGER, 'Bad', 'x', 'd', AT)).toBe(EMPTY_LEDGER);
  });
});
