import { describe, expect, test } from 'bun:test';
import { CODEX_IGNORED_SKILL_KEYS, usesClaudeImports } from '../../daemon/lib/runtimes-kit/mcp.ts';
import { codexRuntimesKit } from '../../daemon/lib/runtimes-kit/index.ts';

describe('what Codex only half reads (its kit says it, not Runtimes)', () => {
  test('declares only the skill keys it can explain', () => {
    expect(Object.keys(CODEX_IGNORED_SKILL_KEYS)).toEqual(['allowed-tools', 'model', 'hooks']);
  });

  test('spots a Claude @path import line and nothing else', () => {
    expect(usesClaudeImports('Intro\n  @docs/a.md  \nmore')).toBe(true);
    expect(usesClaudeImports('write to me@example.com')).toBe(false);
    expect(usesClaudeImports('@ alone')).toBe(false);
  });

  test('lists instructions, then servers, then skills, each in the words of the product', () => {
    const notes = codexRuntimesKit.partialSupport?.({
      instructions: [{ name: 'a', body: '@x.md\n' }],
      mcp: [
        { name: 'sse', url: 'https://feed.example.test/sse' },
        { name: 'http', url: 'https://docs.example.test/mcp' },
      ],
      skills: [{ name: 'mine', items: ['review'] }],
      skillFrontmatter: { review: ['name', 'model'] },
    });
    expect(notes?.map(note => `${note.kind}/${note.name}`)).toEqual(['instructions/a', 'mcp/sse', 'skills/mine']);
  });
});
