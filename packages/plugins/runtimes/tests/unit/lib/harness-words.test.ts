import { describe, expect, test } from 'bun:test';
import { THIRD_HARNESS_KEY } from '@ferretry/core-ferrets/contract/testing';
import {
  harnessName,
  harnessWords,
  isSupportedHarnessKey,
  supportedHarnessKeys,
  unsupportedHarnessSentence,
} from '../../../contract/harness-words.ts';
import { HarnessKeySchema } from '@ferretry/core-ferrets/contract';
import { ImportItemIdSchema, importItemId } from '../../../contract/wire/import-items.ts';
import { ToolInstallRequestSchema } from '../../../contract/wire/setup.ts';
import { unsupportedHarnessSentence as daemonSentence, supportedKinds } from '../../../daemon/lib/harness-kind.ts';
import { parseHarness } from '../../../cli/lib/fleet/account-commands.ts';

/**
 * RUNTIMES PLAN U4b part 1b: the surfaces (app, CLI) read a harness through ONE words table and refuse a key it has no row
 * for with the ONE sentence; the wire carries any well-shaped key and never decides which harness a machine has.
 */
describe('the words a surface says for a harness', () => {
  test('the two shipped harnesses read as before, Claude Code first', () => {
    expect(supportedHarnessKeys()).toEqual(['claude-code', 'codex']);
    expect(harnessName('claude-code')).toBe('Claude Code');
    expect(harnessName('codex')).toBe('Codex');
    expect(harnessWords('claude-code')?.short).toBe('Claude');
    expect(harnessWords('claude-code')?.commandWord).toBe('claude');
  });

  test('a key with no row is shown as it is and is not supported, whatever it is', () => {
    for (const key of [THIRD_HARNESS_KEY, 'gemni', 'constructor', '__proto__', 'claude']) {
      expect(isSupportedHarnessKey(key)).toBe(false);
      expect(harnessWords(key)).toBeUndefined();
      expect(harnessName(key)).toBe(key);
    }
  });

  test('the sentence is written once: the daemon says the same words', () => {
    expect(daemonSentence).toBe(unsupportedHarnessSentence);
    expect(unsupportedHarnessSentence(THIRD_HARNESS_KEY)).toBe(`${THIRD_HARNESS_KEY} is not supported here`);
  });

  test('the words table and the daemon agree on which harnesses Runtimes can run', () => {
    // The daemon's stored words are `claude` and `codex`; each names the plugin key whose row is here.
    expect(supportedKinds().length).toBe(supportedHarnessKeys().length);
    for (const key of supportedHarnessKeys()) expect(isSupportedHarnessKey(key)).toBe(true);
  });
});

describe('the wire is open to a harness key', () => {
  test('a tool install and an import item name the third harness; a malformed key is still refused', () => {
    expect(ToolInstallRequestSchema.safeParse({ harnesses: [THIRD_HARNESS_KEY] }).success).toBe(true);
    expect(ToolInstallRequestSchema.safeParse({ harnesses: ['Not A Key'] }).success).toBe(false);
    expect(ToolInstallRequestSchema.safeParse({ harnesses: [] }).success).toBe(false);
    expect(ImportItemIdSchema.safeParse(importItemId(THIRD_HARNESS_KEY, 'instructions')).success).toBe(true);
    expect(ImportItemIdSchema.safeParse(importItemId('codex', 'settings')).success).toBe(true);
    expect(ImportItemIdSchema.safeParse('codex:nothing').success).toBe(false);
  });

  test('an import item names its harness by the harness grammar, so a prefix HarnessKeySchema refuses is refused here too', () => {
    for (const prefix of ['1x', 'a-', 'a--b', 'x'.repeat(41)]) {
      expect(HarnessKeySchema.safeParse(prefix).success).toBe(false);
      expect(ImportItemIdSchema.safeParse(`${prefix}:env`).success).toBe(false);
    }
  });
});

describe('the CLI names a tool', () => {
  test('claude, claude-code and codex are the shipped tools', () => {
    expect(parseHarness('claude')).toBe('claude-code');
    expect(parseHarness(' Claude-Code ')).toBe('claude-code');
    expect(parseHarness('codex')).toBe('codex');
  });

  test('any other word is refused with the words it could have been, never read as Claude', () => {
    expect(() => parseHarness(THIRD_HARNESS_KEY)).toThrow('is not a tool this machine knows: use claude or codex.');
    expect(() => parseHarness('')).toThrow('use claude or codex');
  });
});
