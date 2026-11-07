import { describe, expect, test } from 'bun:test';
import { mergeClaudeJson } from '../../../daemon/lib/harness/claude-json.ts';
import { CLAUDE_PROMPTS_SEEN, fixedLayer } from '../../../daemon/lib/harness/fixed-layer.ts';

/** Today's wrapper seed (`fleet/src/lib/wrappers.ts` `SEED_FILTER`), as a merge over the document already there. */

const CWD = '/work/repo';
const FRESH = `${JSON.stringify(fixedLayer('auto', CWD).claudeJson, null, 2)}\n`;
const merged = (existing: unknown): unknown => {
  const text = mergeClaudeJson(JSON.stringify(existing), FRESH);
  return text === undefined ? undefined : JSON.parse(text);
};

describe('mergeClaudeJson', () => {
  test('a home with no document (or an empty one) gets the fixed layer whole', () => {
    expect(mergeClaudeJson(undefined, FRESH)).toBe(FRESH);
    expect(mergeClaudeJson('  \n', FRESH)).toBe(FRESH);
    expect(JSON.parse(mergeClaudeJson('null', FRESH) ?? '')).toEqual(JSON.parse(FRESH));
  });

  test('sets the trust key and the fixed keys, and keeps every other key, the project decisions included', () => {
    const existing = {
      userID: 'fake-user',
      hasCompletedOnboarding: false,
      projects: {
        [CWD]: {
          hasTrustDialogAccepted: false,
          enabledMcpjsonServers: ['docs'],
          disabledMcpjsonServers: ['tracker'],
          allowedTools: ['Bash'],
        },
        '/work/other': { disabledMcpjsonServers: ['x'] },
      },
    };
    expect(merged(existing)).toEqual({
      userID: 'fake-user',
      hasCompletedOnboarding: true,
      projects: {
        [CWD]: {
          hasTrustDialogAccepted: true,
          enabledMcpjsonServers: ['docs'],
          disabledMcpjsonServers: ['tracker'],
          allowedTools: ['Bash'],
        },
        '/work/other': { disabledMcpjsonServers: ['x'] },
      },
      ...CLAUDE_PROMPTS_SEEN,
    });
  });

  test("a count keeps the larger value, as jq's max does; a nested seen screen is walked into", () => {
    const out = merged({
      fullscreenUpsellSeenCount: 9,
      hasSeenEffortMediumNudgeByModel: { 'claude-other': true },
    }) as Record<string, unknown>;
    expect(out.fullscreenUpsellSeenCount).toBe(9);
    expect(out.hasSeenEffortMediumNudgeByModel).toEqual({
      'claude-other': true,
      ...CLAUDE_PROMPTS_SEEN.hasSeenEffortMediumNudgeByModel,
    });
    expect((merged({ fullscreenUpsellSeenCount: 1 }) as Record<string, unknown>).fullscreenUpsellSeenCount).toBe(3);
    // jq ranks a string above a number, and null/false below it.
    expect((merged({ fullscreenUpsellSeenCount: 'x' }) as Record<string, unknown>).fullscreenUpsellSeenCount).toBe('x');
    expect((merged({ fullscreenUpsellSeenCount: false }) as Record<string, unknown>).fullscreenUpsellSeenCount).toBe(3);
  });

  test('an already-seeded document is not rewritten', () => {
    const seeded = mergeClaudeJson(JSON.stringify({ projects: { [CWD]: { disabledMcpjsonServers: ['a'] } } }), FRESH);
    expect(seeded).toBeDefined();
    expect(mergeClaudeJson(seeded, FRESH)).toBeUndefined();
  });

  test('a document that cannot be merged is left as it is: not JSON, not an object, or a value in the way', () => {
    expect(mergeClaudeJson('{"projects": {', FRESH)).toBeUndefined();
    expect(mergeClaudeJson('[]', FRESH)).toBeUndefined();
    expect(mergeClaudeJson('"text"', FRESH)).toBeUndefined();
    expect(mergeClaudeJson(JSON.stringify({ projects: [] }), FRESH)).toBeUndefined();
    expect(mergeClaudeJson(JSON.stringify({ projects: { [CWD]: 'x' } }), FRESH)).toBeUndefined();
  });

  test('a server named like an Object.prototype key stays its own decision', () => {
    // Written as text: an object literal's `__proto__` would set a prototype, not a key.
    const existing = `{"projects":{"__proto__":{"a":1},"${CWD}":{"disabledMcpjsonServers":["__proto__","constructor"]}}}`;
    const out = JSON.parse(mergeClaudeJson(existing, FRESH) ?? '{}') as {
      projects: Record<string, { disabledMcpjsonServers?: unknown; hasTrustDialogAccepted?: unknown }>;
    };
    expect(Object.hasOwn(out.projects, '__proto__')).toBe(true);
    expect(out.projects[CWD]?.disabledMcpjsonServers).toEqual(['__proto__', 'constructor']);
    expect(out.projects[CWD]?.hasTrustDialogAccepted).toBe(true);
  });
});
