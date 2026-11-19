import { describe, expect, it } from 'bun:test';
import { emptyMemory, readMemory, withMemory } from '../../../../../app/features/import-wizard/wizard-memory.ts';

describe('what the wizard remembers in the address', () => {
  it('nothing remembered writes no parameter and leaves the rest of the query alone', () => {
    expect(withMemory('?a=1', emptyMemory())).toBe('?a=1');
    expect(withMemory('', emptyMemory())).toBe('');
  });

  it('round-trips the tool, names, left-out items and ticked tokens, beside other parameters', () => {
    const memory = {
      tool: 1,
      names: { codex: 'work-codex' },
      left: { 'claude-code': new Set(['claude-code:mcp:issues' as const]), codex: new Set<never>() },
      ticked: { 'claude-code': new Set(['GITHUB_TOKEN']), codex: new Set<string>() },
    };
    const search = withMemory('?a=1', memory) ?? '';
    expect(search).toContain('a=1');
    const read = readMemory(search);
    expect(read.tool).toBe(1);
    expect(read.names).toEqual({ codex: 'work-codex' });
    expect([...read.left['claude-code']]).toEqual(['claude-code:mcp:issues']);
    expect([...read.ticked['claude-code']]).toEqual(['GITHUB_TOKEN']);
  });

  it('a damaged or hand-edited parameter reads as nothing remembered', () => {
    for (const bad of [
      '?fyimport=not-json',
      '?fyimport=%7B%22tool%22%3A9%7D',
      '?fyimport=%7B%22left%22%3A%7B%22codex%22%3A%5B%22x%22%5D%7D%7D',
    ])
      expect(readMemory(bad).tool).toBe(0);
    expect(readMemory('?fyimport=%7B%22left%22%3A%7B%22codex%22%3A%5B%22x%22%5D%7D%7D').left.codex.size).toBe(0);
  });

  it('an address that would be too long is not written', () => {
    const many = new Set(Array.from({ length: 300 }, (_, at) => `codex:skill:${'s'.repeat(40)}${String(at)}` as const));
    expect(withMemory('', { ...emptyMemory(), left: { 'claude-code': new Set(), codex: many } })).toBeNull();
  });
});
