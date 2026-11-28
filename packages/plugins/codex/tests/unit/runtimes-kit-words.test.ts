import { describe, expect, it } from 'bun:test';
import { codexRuntimesKit } from '../../daemon/lib/runtimes-kit/index.ts';

describe('Codex kit words', () => {
  it('should name the command that starts it and the variable that points it at its home', () => {
    expect(codexRuntimesKit.command).toBe('codex');
    expect(codexRuntimesKit.homeEnv).toBe('CODEX_HOME');
  });

  it('should keep the skills folder its first start fills with its bundled skills', () => {
    expect(codexRuntimesKit.ownedSkillEntries).toEqual(['.system']);
  });

  it('should give no fast-mode rule: whether a model has fast mode is the live account to say', () => {
    expect(codexRuntimesKit.fastSupport).toBeUndefined();
  });
});
