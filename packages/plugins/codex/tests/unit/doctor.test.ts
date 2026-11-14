import { describe, expect, test } from 'bun:test';
import { codexDoctor } from '../../daemon/lib/doctor.ts';
import type { HarnessLocation } from '../../daemon/lib/update/ports.ts';

const IMPACT =
  'A wrapper the fleet publishes for a codex account runs `codex`, so no codex session can start on this host. Accounts on the other harness are unaffected.';

const run = async (location: HarnessLocation) => await codexDoctor(async () => location)();

describe('codex-paths: which codex, and by which rule (v4 harnessCommand)', () => {
  test('V-0257 a located codex is an ok `codex` row naming the file and the rule, and never a required one', async () => {
    expect(
      await run({
        outcome: 'located',
        path: '/usr/local/bin/codex',
        rule: 'extra search path',
        declaredBy: 'harness-codex.yaml searchPaths',
      }),
    ).toEqual({
      state: 'ok',
      name: 'codex',
      requirement: 'alternative',
      detail: '/usr/local/bin/codex  (extra search path — harness-codex.yaml searchPaths)',
      fix: IMPACT,
    });
  });

  test('V-0257 an explicit path that runs nothing is "declared, and unusable" and leads with its reason', async () => {
    expect(
      await run({
        outcome: 'override-absent',
        path: '/nope/codex',
        declaredBy: 'harness-codex.yaml binary',
        reason: 'harness-codex.yaml binary names /nope/codex for codex and this host cannot run that file',
      }),
    ).toEqual({
      state: 'warn',
      name: 'codex',
      requirement: 'alternative',
      detail: 'declared, and unusable',
      fix: `harness-codex.yaml binary names /nope/codex for codex and this host cannot run that file. ${IMPACT}`,
    });
  });

  test('V-0257 an absent codex names where it looked, and a lookup that throws is no row', async () => {
    expect(await run({ outcome: 'absent', searched: ['/a/codex', 'PATH'] })).toMatchObject({
      state: 'warn',
      detail: 'not found in the inherited environment, nor in /a/codex, PATH',
    });
    expect(
      await codexDoctor(async () => {
        throw new Error('boom');
      })(),
    ).toBeUndefined();
  });
});
