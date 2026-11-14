import { describe, expect, test } from 'bun:test';
import type { ClaudeLocation } from '../../../daemon/lib/update/ports.ts';
import { claudeCodeDoctor } from '../../../daemon/lib/harness/doctor.ts';

const IMPACT =
  'A wrapper the fleet publishes for a claude account runs `claude`, so no claude session can start on this host. Accounts on the other harness are unaffected.';

const run = async (location: ClaudeLocation) => await claudeCodeDoctor(async () => location)();

describe('claude-code-paths: which claude, and by which rule (v4 harnessCommand)', () => {
  test('V-0257 a located claude is an ok `claude` row naming the file and the rule that chose it, and never a required one', async () => {
    expect(
      await run({
        outcome: 'located',
        path: '/opt/homebrew/bin/claude',
        rule: 'inherited environment',
        declaredBy: 'PATH',
      }),
    ).toEqual({
      state: 'ok',
      name: 'claude',
      requirement: 'alternative',
      detail: '/opt/homebrew/bin/claude  (inherited environment — PATH)',
      fix: IMPACT,
    });
  });

  test('V-0257 an explicit path that starts nothing is "declared, and unusable", with the reason leading the consequence, and it does not fail', async () => {
    const finding = await run({
      outcome: 'override-absent',
      path: '/nope/claude',
      declaredBy: 'config/harness-claude-code.yaml binary',
      reason: 'nothing there starts when asked for its version',
    });
    expect(finding).toMatchObject({
      state: 'warn',
      name: 'claude',
      requirement: 'alternative',
      detail: 'declared, and unusable',
    });
    expect(finding?.fix).toBe(
      `config/harness-claude-code.yaml binary names /nope/claude, and nothing there starts when asked for its version. ${IMPACT}`,
    );
  });

  test('V-0257 an absent claude says where it looked, or that no extra search path is declared', async () => {
    expect(await run({ outcome: 'absent', searched: ['PATH'] })).toMatchObject({
      state: 'warn',
      requirement: 'alternative',
      detail: 'not found in the inherited environment, nor in PATH',
      fix: IMPACT,
    });
    expect(await run({ outcome: 'absent', searched: [] })).toMatchObject({
      detail: 'not found in the inherited environment, and no extra search path is declared',
    });
  });

  test('V-0257 a lookup that throws is no row, never a guess', async () => {
    const finding = await claudeCodeDoctor(async () => {
      throw new Error('boom');
    })();
    expect(finding).toBeUndefined();
  });
});
