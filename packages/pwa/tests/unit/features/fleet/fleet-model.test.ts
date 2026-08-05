import { describe, expect, it } from 'bun:test';

import { defaultFleetHarness } from '../../../../src/features/fleet/fleet-model.ts';

describe('defaultFleetHarness', () => {
  it('uses the owner rule: Claude wins when both harnesses can launch', () => {
    expect(
      defaultFleetHarness([
        { kind: 'codex', launchable: ['codex-auto-studio'], blocked: [] },
        { kind: 'claude', launchable: ['claude-auto-studio'], blocked: [] },
      ]),
    ).toBe('claude');
  });

  it('falls back to Codex only when Claude has no positively launchable wrapper', () => {
    expect(
      defaultFleetHarness([
        { kind: 'claude', launchable: [], blocked: ['wrapper missing'] },
        { kind: 'codex', launchable: ['codex-auto-studio'], blocked: [] },
      ]),
    ).toBe('codex');
  });

  it('does not invent a default from absent evidence', () => {
    expect(defaultFleetHarness([])).toBeUndefined();
    expect(defaultFleetHarness([{ kind: 'claude', launchable: [], blocked: [] }])).toBeUndefined();
  });
});
