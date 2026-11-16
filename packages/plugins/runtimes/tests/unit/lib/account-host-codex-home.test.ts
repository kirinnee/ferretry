import { describe, expect, it } from 'bun:test';
import { hostCodexHome } from '../../../daemon/lib/account/credentials.ts';

describe('the person’s own Codex home, resolved the way Codex resolves it', () => {
  it('is <home>/.codex when CODEX_HOME is unset, empty or only spaces', () => {
    for (const variable of [undefined, '', '   ']) {
      expect(hostCodexHome(variable, '/home/person')).toBe('/home/person/.codex');
    }
  });

  it('is CODEX_HOME when it names an absolute directory', () => {
    expect(hostCodexHome('/data/codex', '/home/person')).toBe('/data/codex');
    expect(hostCodexHome('  /data/codex  ', '/home/person')).toBe('/data/codex');
  });

  it('is nothing when CODEX_HOME is relative, because the shell’s directory is not the daemon’s to guess', () => {
    expect(hostCodexHome('codex-home', '/home/person')).toBeUndefined();
    expect(hostCodexHome('./codex', '/home/person')).toBeUndefined();
    expect(hostCodexHome('~/codex', '/home/person')).toBeUndefined();
  });
});
