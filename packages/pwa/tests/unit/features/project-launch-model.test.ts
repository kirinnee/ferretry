import { describe, expect, it } from 'bun:test';

import { projectLaunchRequest } from '../../../src/features/projects/project-launch-model.ts';

describe('projectLaunchRequest', () => {
  it('builds a top-level interactive session rooted in the project folder', () => {
    // Act
    const request = projectLaunchRequest('claude-auto-loge', '/work/ferretry');

    // Assert
    expect(request).toEqual({
      agent: 'claude-auto-loge',
      cwd: '/work/ferretry',
      mode: 'interactive',
      boardAccess: 'none',
    });
  });

  it('trims the typed wrapper name rather than sending the whitespace with it', () => {
    // Act
    const request = projectLaunchRequest('  codex-auto-loio \n', '/work/ferretry');

    // Assert
    expect(request.agent).toBe('codex-auto-loio');
  });

  it('refuses a blank wrapper at the schema instead of asking the daemon to', () => {
    // Act / Assert — the request is parsed, so an unusable draft never leaves
    // the browser and the refusal is the protocol's own.
    expect(() => projectLaunchRequest('   ', '/work/ferretry')).toThrow();
  });

  it('refuses an empty project path', () => {
    // Act / Assert
    expect(() => projectLaunchRequest('claude', '')).toThrow();
  });
});
