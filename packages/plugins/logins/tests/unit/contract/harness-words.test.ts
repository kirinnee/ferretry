import { THIRD_HARNESS_KEY } from '@ferretry/core-ferrets/contract/testing';
import { describe, expect, test } from 'bun:test';
import {
  harnessCommandWord,
  harnessHalf,
  harnessKeyOfCommand,
  harnessKeyOfWord,
  HarnessKeyOnWireSchema,
  harnessName,
  harnessWords,
  isHarnessKey,
  isSupportedHarnessKey,
  supportedHarnessKeys,
  unsupportedHarnessSentence,
} from '../../../contract/harness-words.ts';

/**
 * RUNTIMES PLAN U4b (Logins): what the contract, the app and the CLI say about a harness comes from ONE table, and a key with
 * no row is refused with ONE sentence. The unknown key is the fake third harness's and a typo.
 */
const UNKNOWN = [THIRD_HARNESS_KEY, 'gemni'] as const;

describe('the two shipped harnesses', () => {
  test('are listed Claude Code first, with the words and stored half every surface used before', () => {
    expect(supportedHarnessKeys()).toEqual(['claude-code', 'codex']);
    expect(harnessWords('claude-code')).toMatchObject({ name: 'Claude Code', short: 'Claude', commandWord: 'claude' });
    expect(harnessWords('codex')).toMatchObject({ name: 'Codex', short: 'Codex', commandWord: 'codex' });
    expect(harnessHalf('claude-code')).toBe('claude');
    expect(harnessHalf('codex')).toBe('codex');
    expect(harnessName('claude-code')).toBe('Claude Code');
    expect(harnessCommandWord('codex')).toBe('codex');
  });

  test('are found by a person’s word, by their plugin key or by their command', () => {
    expect(harnessKeyOfWord(' Claude ')).toBe('claude-code');
    expect(harnessKeyOfWord('claude-code')).toBe('claude-code');
    expect(harnessKeyOfWord('CODEX')).toBe('codex');
    expect(harnessKeyOfCommand('claude')).toBe('claude-code');
    expect(harnessKeyOfCommand('claude-code')).toBeUndefined();
  });

  test('narrow a record tagged with their key', () => {
    const flow = { harness: 'codex', state: 'complete' } as const;

    expect(isHarnessKey(flow, 'codex')).toBe(true);
    expect(isHarnessKey(flow, 'claude-code')).toBe(false);
    expect(HarnessKeyOnWireSchema.parse('claude-code')).toBe('claude-code');
  });
});

describe.each(UNKNOWN)('a harness Logins has no behaviour for (%s)', unknown => {
  test('has no words, is shown as it is, and has no command', () => {
    expect(isSupportedHarnessKey(unknown)).toBe(false);
    expect(harnessWords(unknown)).toBeUndefined();
    expect(harnessName(unknown)).toBe(unknown);
    expect(harnessKeyOfWord(unknown)).toBeUndefined();
    expect(() => harnessCommandWord(unknown)).toThrow(unsupportedHarnessSentence(unknown));
  });

  test('is refused on the wire with the one sentence', () => {
    const parsed = HarnessKeyOnWireSchema.safeParse(unknown);

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(`${unknown} is not supported here`);
    expect(HarnessKeyOnWireSchema.safeParse(7).success).toBe(false);
  });
});
