/**
 * W2-a: Runtimes' answer to Ferrets' `auto-resume.decide` (RULING #27 Q5). Ferrets resumes only on this answer's own
 * yes, so every doubt here must be a no: a switch that cannot be read, a runtime that does not resolve, a question that
 * does not parse.
 */
import { describe, expect, test } from 'bun:test';
import type { ResolveResult, RuntimeId } from '../../../contract/index.ts';
import { unavailableAssembly } from '../../../daemon/index.ts';
import {
  AUTO_RESUME_SWITCH_UNREAD,
  autoResumeAnswer,
  autoResumeSwitch,
  readAutoResume,
} from '../../../daemon/lib/service/auto-resume-answer.ts';

const FERRET = 'mw7bp88g-50e00159';
const resolving = (answer: ResolveResult) => {
  const asked: (RuntimeId | undefined)[] = [];
  return { asked, resolve: async (id?: RuntimeId) => (asked.push(id), answer) };
};
const READY = { ok: true, runtime: { id: 'claude-work' } } as unknown as ResolveResult;

describe('W2-a autoResumeAnswer', () => {
  test('W2-a the switch: yes only when it is read and on', async () => {
    const { resolve } = resolving(READY);
    expect(await autoResumeAnswer({ switchOn: () => true, resolve })({ ask: 'switch' })).toEqual({ allow: true });
    expect(await autoResumeAnswer({ switchOn: () => false, resolve })({ ask: 'switch' })).toEqual({
      allow: false,
      reason: 'Auto-resume after restart is off on this machine',
    });
    expect(await autoResumeAnswer({ switchOn: () => undefined, resolve })({ ask: 'switch' })).toEqual({
      allow: false,
      reason: AUTO_RESUME_SWITCH_UNREAD,
    });
  });

  test("W2-a this build's default assembly reaches no switch, so the real half answers the switch no", async () => {
    const ctx = {
      kernel: { clock: { nowMs: () => 0 }, log: { warn: () => undefined } },
      needs: { logins: { list: async () => ({ logins: [] }) }, loginChanges: {} },
    } as unknown as Parameters<typeof unavailableAssembly>[0];
    const assembly = unavailableAssembly(ctx);
    expect(assembly.autoResume).toBeUndefined();
    const { resolve } = resolving(READY);
    expect(await autoResumeAnswer({ switchOn: () => assembly.autoResume?.(), resolve })({ ask: 'switch' })).toEqual({
      allow: false,
      reason: AUTO_RESUME_SWITCH_UNREAD,
    });
  });

  test('W2-a the runtime: yes only when it resolves; otherwise its own sentence', async () => {
    const ready = resolving(READY);
    expect(
      await autoResumeAnswer({ switchOn: () => true, resolve: ready.resolve })({
        ask: 'runtime',
        ferret: FERRET,
        harness: 'claude-code',
        runtime: 'claude-work',
      }),
    ).toEqual({ allow: true });
    expect(ready.asked).toEqual(['claude-work' as RuntimeId]);
    const refused = resolving({ ok: false, refusal: 'not_signed_in', sentence: 'Login work needs sign-in' });
    expect(
      await autoResumeAnswer({ switchOn: () => true, resolve: refused.resolve })({
        ask: 'runtime',
        ferret: FERRET,
        harness: 'claude-code',
        runtime: 'claude-work',
      }),
    ).toEqual({ allow: false, reason: 'Login work needs sign-in' });
  });

  test('BG-038 the switch is read for every ferret: turned off after the first resume, the rest are NOT resumed', async () => {
    const { asked, resolve } = resolving(READY);
    let on = true;
    const answer = autoResumeAnswer({ switchOn: () => on, resolve });
    const question = (runtime: string) => ({
      ask: 'runtime' as const,
      ferret: FERRET,
      harness: 'claude-code' as const,
      runtime,
    });
    expect(await answer({ ask: 'switch' })).toEqual({ allow: true });
    expect(await answer(question('claude-one'))).toEqual({ allow: true });
    on = false;
    for (const runtime of ['claude-two', 'claude-three'])
      expect(await answer(question(runtime))).toEqual({
        allow: false,
        reason: 'Auto-resume after restart is off on this machine',
      });
    expect(asked).toEqual(['claude-one' as RuntimeId]);
  });

  test('BG-038 a switch that cannot be read when a ferret is asked about is a no, and resolves nothing', async () => {
    const { asked, resolve } = resolving(READY);
    const answer = autoResumeAnswer({ switchOn: () => undefined, resolve });
    expect(await answer({ ask: 'runtime', ferret: FERRET, harness: 'claude-code', runtime: 'claude-work' })).toEqual({
      allow: false,
      reason: AUTO_RESUME_SWITCH_UNREAD,
    });
    expect(asked).toEqual([]);
  });

  test('BG-024 an assembly that cannot read the switch is a no: `undefined` never falls through to the file', () => {
    expect(
      readAutoResume(
        () => undefined,
        () => true,
      ),
    ).toBeUndefined();
    expect(
      readAutoResume(
        () => false,
        () => true,
      ),
    ).toBe(false);
    expect(
      readAutoResume(
        () => true,
        () => false,
      ),
    ).toBe(true);
    expect(readAutoResume(undefined, () => true)).toBe(true);
    expect(readAutoResume(undefined, () => undefined)).toBeUndefined();
  });

  test('BG-024 a file that cannot be read (unreadable, a link, too large, broken) reads as no, whatever older version is kept', () => {
    // The kernel says `invalid` for every one of those and keeps the last good value in effect.
    expect(autoResumeSwitch('invalid', { autoResume: true })).toBeUndefined();
    expect(autoResumeSwitch('invalid', {})).toBeUndefined();
    expect(autoResumeSwitch('invalid', undefined)).toBeUndefined();
    expect(autoResumeSwitch('valid', undefined)).toBeUndefined();
  });

  test('W2-a a question that does not parse, or a runtime name this machine cannot have, is a no and resolves nothing', async () => {
    const { asked, resolve } = resolving(READY);
    const answer = autoResumeAnswer({ switchOn: () => true, resolve });
    for (const input of [undefined, null, {}, { ask: 'everything' }, { ask: 'runtime', runtime: 'x' }])
      expect((await answer(input)).allow).toBe(false);
    expect(
      (await answer({ ask: 'runtime', ferret: FERRET, harness: 'claude-code', runtime: 'Not A Runtime!' })).allow,
    ).toBe(false);
    expect(asked).toEqual([]);
  });
});
