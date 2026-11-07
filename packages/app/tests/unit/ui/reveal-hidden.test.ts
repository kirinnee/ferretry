import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { revealHidden } from '../../../src/ui/lib/reveal-hidden.ts';

describe('revealHidden', () => {
  it('holds its own character class as escapes, never as the characters', () => {
    const source = readFileSync(new URL('../../../src/ui/lib/reveal-hidden.ts', import.meta.url), 'utf8');
    // A source that holds a hidden character itself could not be read or reviewed (Trojan Source).
    expect(revealHidden(source)).toBe(source);
    expect(source).toContain(String.raw`\u202E`);
  });

  it('writes out the characters that change how text looks without being seen', () => {
    expect(revealHidden('a‮b')).toBe('a⟨U+202E⟩b');
    expect(revealHidden('a​b')).toBe('a⟨U+200B⟩b');
    expect(revealHidden('a­b')).toBe('a⟨U+00AD⟩b');
    expect(revealHidden('a\u0000b')).toBe('a⟨U+0000⟩b');
    expect(revealHidden('a\u{E0041}b')).toBe('a⟨U+E0041⟩b');
  });

  it('leaves ordinary text, tabs, newlines and CRLF alone, and marks a bare carriage return', () => {
    expect(revealHidden('plain text, ünïcode ✓\tand\nlines\r\nend')).toBe('plain text, ünïcode ✓\tand\nlines\r\nend');
    expect(revealHidden('a\rb')).toBe('a⟨U+000D⟩b');
  });
});
