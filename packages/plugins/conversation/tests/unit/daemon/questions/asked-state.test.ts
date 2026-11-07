import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { fixedClock, testHost } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { CONVERSATION_STATE, ConversationPort, QUESTION_STATE } from '../../../../contract/index.ts';
import daemon from '../../../../daemon/index.ts';
import { readAskedQuestion, writeAskedQuestion } from '../../../../daemon/questions/adapters/state-asked-question.ts';
import { parseAskedQuestion } from '../../../../daemon/questions/lib/asked.ts';
import { fixtureTexts } from '../../../support/fixtures.ts';
import { memoryStatePort } from '../../../support/state.ts';

/** The live `PreToolUse` payload of `asked.test.ts` (Claude Code 2.1.281, one `AskUserQuestion` call). */
const fixture = await fixtureTexts(join(import.meta.dir, '../../../fixtures/question-asked'));
const PAYLOAD = fixture('claude-2.1.281-pretooluse.json');
const TRANSCRIPT = '/home/user/.claude/projects/-work-repro/48fa096f-185c-42e1-b456-33dd3c77c5ce.jsonl';
const ASKED_AT = '2026-10-30T04:33:36.000Z' as Instant;
const F1 = ferretId('f1');

/** The real daemon half on the test host, its state the test's own memory port. */
async function conversation() {
  const state = memoryStatePort(CONVERSATION_STATE);
  const ferrets = new FakeFerrets();
  ferrets.add({ id: F1, state: 'working' });
  const implementation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
      const build = daemon.build;
      if (build === undefined) throw new Error('the conversation daemon half has no build');
      return build({ ...ctx, kernel: { ...ctx.kernel, state } });
    },
  } as typeof daemon;
  const host = await testHost({
    plugins: [implementation],
    fakes: { ferrets, asks: new FakeAsks() },
    clock: fixedClock('2026-10-30T04:40:00Z'),
  });
  return { host, state };
}

describe('question.json holds the parsed question, never the raw hook payload', () => {
  test('F-0331 the hook payload is parsed when written, and both readers read it back', async () => {
    const { host, state } = await conversation();
    const written = await writeAskedQuestion(state, F1, PAYLOAD, ASKED_AT, TRANSCRIPT);
    expect(written).toEqual({
      format: 1,
      toolUseId: 'toolu_01T4KnfY1in2GTL7P9wUmRtt',
      header: 'Web address',
      text: 'Choice 1 of 5 — what web address should the test-report viewer live at?',
      options: [
        {
          label: 'reports.example.dev (Recommended)',
          description: 'A clean address on a domain you already have in Cloudflare.',
        },
        { label: 'tests.example.dev', description: 'Same idea, different word.' },
        { label: '…example.workers.dev', description: "Cloudflare's free built-in address. No setup, but long." },
      ],
      multiple: false,
      askedAt: ASKED_AT,
      transcript: TRANSCRIPT,
    });
    // Stored as the schema, nothing of the envelope (no hook_event_name, tool_input, transcript_path).
    const stored = await state.read(QUESTION_STATE, F1);
    expect(stored.ok && stored.value).toEqual(written as never);
    expect(JSON.stringify(stored)).not.toContain('hook_event_name');

    // The transcript-proven evidence: what the raw payload would have given.
    const raw = parseAskedQuestion(PAYLOAD, Date.parse(ASKED_AT), TRANSCRIPT);
    const asked = await readAskedQuestion(state, F1, TRANSCRIPT);
    expect(asked?.toolUseId).toBe(raw?.toolUseId as string);
    expect(asked?.askedAtMs).toBe(raw?.askedAtMs as number);
    expect(asked?.questions).toEqual(raw?.questions as never);
    expect(asked?.input).toEqual(raw?.input as never);

    // The port (and so `GET /v1/ferrets/:ferretId/question`) answers the question without the transcript it was proved against.
    const { transcript: _proof, ...question } = written ?? {};
    expect(await host.provided(ConversationPort).question(F1)).toEqual(question as never);
    await host.stop();
  });

  test('a question proved against another transcript is not this reader’s question', async () => {
    const { host, state } = await conversation();
    await writeAskedQuestion(state, F1, PAYLOAD, ASKED_AT, TRANSCRIPT);
    expect(await readAskedQuestion(state, F1, '/home/user/.claude/projects/-work-repro/other.jsonl')).toBeUndefined();
    expect(await readAskedQuestion(state, F1, undefined)).toBeUndefined();
    await host.stop();
  });

  test('what cannot be stored whole is not written: another transcript, another tool, several questions at once', async () => {
    const { host, state } = await conversation();
    const envelope = JSON.parse(PAYLOAD) as { tool_input: { questions: unknown[] } };
    const twice = JSON.stringify({
      ...envelope,
      tool_input: { questions: [envelope.tool_input.questions[0], envelope.tool_input.questions[0]] },
    });
    for (const [payload, transcript] of [
      [PAYLOAD, '/home/user/.claude/projects/-work-repro/other.jsonl'],
      [PAYLOAD, undefined],
      [JSON.stringify({ ...envelope, tool_name: 'Bash' }), TRANSCRIPT],
      [twice, TRANSCRIPT],
      ['not json', TRANSCRIPT],
    ] as const)
      expect(await writeAskedQuestion(state, F1, payload, ASKED_AT, transcript)).toBeUndefined();
    const stored = await state.read(QUESTION_STATE, F1);
    expect(stored.ok && stored.value).toBeUndefined();
    expect(await host.provided(ConversationPort).question(F1)).toBeUndefined();
    await host.stop();
  });
});
