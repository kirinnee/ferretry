import { describe, expect, test } from 'bun:test';
import { THIRD_HARNESS_KEY } from '@ferretry/core-ferrets/contract/testing';
import type { HostLogin } from '../../../contract/index.ts';
import { renderMcpComponents } from '../../../daemon/lib/account/adapt.ts';
import { credentialLaunchEnvironment, resolveCredentialStore } from '../../../daemon/lib/account/credentials.ts';
import { deriveRuntimes } from '../../../daemon/lib/account/derived-runtimes.ts';
import { applyFixedLayer, fixedLayerFor } from '../../../daemon/lib/account/fixed-layer.ts';
import { loginNote, scannedMcpServers } from '../../../daemon/lib/account/import.ts';
import { AccountModelSchema, parseForeignComponent } from '../../../daemon/lib/account/schema.ts';
import {
  byHarness,
  harnessKeyOfKind,
  harnessKindOfKey,
  isKind,
  isSupportedKind,
  supportedKinds,
  supportedKindOfKey,
  UnsupportedHarnessError,
  unsupportedHarnessSentence,
} from '../../../daemon/lib/harness-kind.ts';

/**
 * RUNTIMES PLAN U4b: a harness Runtimes has no behaviour for is REFUSED by name wherever the code once read "if codex … else
 * Claude", and never handed Claude's paths, flags or parser. The unknown harness here is the fake third harness's key and a
 * typo (`gemni`); both must refuse with the one sentence.
 */
const UNKNOWN = [THIRD_HARNESS_KEY, 'gemni'] as const;

const refusal = (word: string): string => unsupportedHarnessSentence(word);
const refused = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedHarnessError);
    return (error as Error).message;
  }
  throw new Error('expected a refusal, but nothing was refused');
};

describe('the stored words of the two shipped harnesses stay what they were on disk', () => {
  test('claude is the plugin claude-code and codex is codex, both ways', () => {
    expect(supportedKinds()).toEqual(['claude', 'codex']);
    expect(harnessKindOfKey('claude-code')).toBe('claude');
    expect(harnessKindOfKey('codex')).toBe('codex');
    expect(harnessKeyOfKind('claude')).toBe('claude-code');
    expect(harnessKeyOfKind('codex')).toBe('codex');
  });

  test('a word and its key name the same harness', () => {
    expect(isKind('claude', 'claude')).toBe(true);
    expect(isKind('claude-code', 'claude')).toBe(true);
    expect(isKind('codex', 'claude')).toBe(false);
    expect(supportedKindOfKey('claude-code')).toBe('claude');
  });
});

describe.each(UNKNOWN)('a harness Runtimes has no behaviour for (%s)', unknown => {
  test('is no supported word or key', () => {
    expect(isSupportedKind(unknown)).toBe(false);
    expect(supportedKindOfKey(unknown)).toBeUndefined();
    expect(isKind(unknown, 'claude')).toBe(false);
    expect(isKind(unknown, 'codex')).toBe(false);
  });

  test('is refused by the key door with the one sentence', () => {
    expect(refused(() => harnessKindOfKey(unknown))).toBe(refusal(unknown));
  });

  test('is refused by byHarness, which runs neither case', () => {
    let ran = false;
    const cases = {
      claude: () => (ran = true),
      codex: () => (ran = true),
    };
    expect(refused(() => byHarness(unknown, cases))).toBe(refusal(unknown));
    expect(ran).toBe(false);
  });

  test('is refused where the fixed launch layer was Claude unless it was Codex', () => {
    const input = { harness: unknown, agentPermissions: 'skip', cwd: '/x', fyCommand: 'fy' } as never;
    expect(refused(() => fixedLayerFor(input))).toBe(refusal(unknown));
  });

  test('is refused where a credential store was Claude unless it was Codex', () => {
    const credential = { harness: unknown, store: 'ferretry' } as never;
    const paths = { userHome: '/home/x', hostCodexHome: undefined };
    expect(refused(() => resolveCredentialStore('login', credential, paths, undefined))).toBe(refusal(unknown));
    expect(
      refused(() => resolveCredentialStore('login', { harness: unknown, store: 'host' } as never, paths, undefined)),
    ).toBe(refusal(unknown));
  });

  test('is refused where a resolved credential asked for its launch variables', () => {
    const resolution = { harness: unknown, store: 'host', secureStorage: '', storageDirectory: '/x' } as never;
    expect(refused(() => credentialLaunchEnvironment(resolution, undefined))).toBe(refusal(unknown));
  });

  test('is refused where MCP servers were rendered in Claude’s shape unless Codex’s', () => {
    const servers = { s: { command: 'x' } } as never;
    expect(refused(() => renderMcpComponents(unknown as never, servers))).toBe(refusal(unknown));
  });

  test('is refused where a host scan read Claude’s MCP document unless Codex’s', () => {
    const scan = { harness: unknown, settings: { kind: 'absent' }, problems: [] } as never;
    expect(refused(() => scannedMcpServers(scan))).toBe(refusal(unknown));
  });

  test('is refused where a launch layer folded appended instructions in Claude’s way unless Codex’s', () => {
    const resolved = { flags: [], settings: { leaves: [] }, mcp: [] } as never;
    const fixed = {
      harness: unknown,
      agentPermissions: 'skip',
      entries: [{ purpose: 'instructions', target: 'launch', path: ['x'], value: 'x' }],
      args: [],
    } as never;
    expect(refused(() => applyFixedLayer(resolved, fixed))).toBe(refusal(unknown));
  });

  test('is refused where a host login note named Claude’s command unless Codex’s', () => {
    const login: HostLogin = { state: 'unknown', reason: 'x' };
    expect(refused(() => loginNote(unknown as never, login))).toBe(refusal(unknown));
  });
});

describe('a typed harness word in an owner’s file surfaces as that file’s refusal, never a crash and never Claude', () => {
  test('a login in the account document names the word', () => {
    const parsed = AccountModelSchema.safeParse({
      version: 1,
      credentials: { typo: { harness: 'gemni', store: 'host' } },
    });
    expect(parsed.success).toBe(false);
    const issues = parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
    expect(issues).toContain(`credentials.typo.harness: ${refusal('gemni')}`);
  });

  test('a component another plugin owns names the word, so its kind is unread with the sentence', () => {
    for (const kind of ['settings', 'hooks', 'instructions'] as const) {
      const checked = parseForeignComponent(kind, { harness: 'gemni', file: 'a.json' });
      expect(checked).toEqual({ ok: false, issues: expect.arrayContaining([refusal('gemni')]) });
    }
  });

  test('the fake third harness’s key is no harness word either', () => {
    const checked = parseForeignComponent('settings', { harness: THIRD_HARNESS_KEY, file: 'a.json' });
    expect(checked).toEqual({ ok: false, issues: expect.arrayContaining([refusal(THIRD_HARNESS_KEY)]) });
  });

  test('the two shipped words still parse', () => {
    expect(parseForeignComponent('settings', { harness: 'claude', file: 'a.json' }).ok).toBe(true);
    expect(parseForeignComponent('settings', { harness: 'codex', file: 'a.json' }).ok).toBe(true);
  });
});

describe('a login that drives only the fake third harness', () => {
  test('derives no runtime: it is never handed Claude’s', () => {
    const login = {
      id: 'third-login',
      store: 'ferretry',
      harness: THIRD_HARNESS_KEY,
      harnesses: [THIRD_HARNESS_KEY],
      status: { word: 'signed_in' },
    } as never;
    const derived = deriveRuntimes({
      logins: [login],
      runtimes: new Map(),
      profiles: new Map(),
      modelSets: new Map(),
    } as never);
    expect([...derived.runtimes.keys()]).toEqual([]);
  });
});
