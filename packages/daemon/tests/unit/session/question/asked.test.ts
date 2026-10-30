import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import should from 'should';
import {
  type AskedQuestion,
  parseAskedQuestion,
  withAskedQuestion,
} from '../../../../src/lib/session/question/asked.ts';
import { projectStructuredQuestion } from '../../../../src/lib/session/question/projection.ts';
import { ClaudeTranscriptParser } from '../../../../src/lib/transcript/claude.ts';
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

/**
 * LIVE BYTES, Claude Code 2.1.281 (`tests/fixtures/question-asked/`), from a real interactive ferret that
 * called `AskUserQuestion` once:
 *
 * - `claude-2.1.281-open.jsonl` — the end of its transcript as it stood while the form was on screen.
 *   The call was asked at 04:33:35.961 and is NOT in it: it reached the file at 04:36:02, with its answer.
 * - `claude-2.1.281-answered.jsonl` — the two records that landed when the form was answered.
 * - `claude-2.1.281-pretooluse.json` — what the fixed overlay's `PreToolUse` hook is handed for that call:
 *   the envelope exactly as a live hook received it, carrying this call's id and input.
 *
 * Paths are rewritten under `/home/user` and `/work`; nothing else is changed.
 */
const fixture = (name: string): string =>
  readFileSync(new URL(`../../../fixtures/question-asked/${name}`, import.meta.url), 'utf8');
const events = (name: string): readonly TranscriptEvent[] =>
  new ClaudeTranscriptParser().parse({ text: fixture(name), endOfInput: true }).events;

const PAYLOAD = fixture('claude-2.1.281-pretooluse.json');
const TRANSCRIPT = '/home/user/.claude/projects/-work-repro/48fa096f-185c-42e1-b456-33dd3c77c5ce.jsonl';
const TOOL_USE_ID = 'toolu_01T4KnfY1in2GTL7P9wUmRtt';
/** When the hook wrote its file: after the call was made (04:33:35.961), before the form was drawn. */
const HOOK_AT = Date.parse('2026-10-30T04:33:36.000Z');

const asked = (): AskedQuestion => {
  const parsed = parseAskedQuestion(PAYLOAD, HOOK_AT, TRANSCRIPT);
  if (parsed === undefined) throw new Error('the live payload did not parse');
  return parsed;
};

const payloadWith = (patch: Record<string, unknown>): string => JSON.stringify({ ...JSON.parse(PAYLOAD), ...patch });

describe('the question a Claude form is asking', () => {
  describe('the regression, on live bytes', () => {
    it('should find no question in the transcript alone while the form is open', () => {
      // Act — what the daemon projected before the hook existed.
      const projection = projectStructuredQuestion(events('claude-2.1.281-open.jsonl'));

      // Assert — the bug: an open form reads as no question at all.
      should(projection).deepEqual({ kind: 'none' });
    });

    it('should project the open question, whole, from the hook beside the same transcript', () => {
      // Act
      const projection = projectStructuredQuestion(withAskedQuestion(events('claude-2.1.281-open.jsonl'), asked()));

      // Assert — the model's own call id, and every option the form draws.
      should(projection.kind).equal('pending');
      if (projection.kind !== 'pending') return;
      should(projection.question.toolUseId).equal(TOOL_USE_ID);
      should(projection.question.askedAt).equal('2026-10-30T04:33:36.000Z');
      should(projection.question.questions).deepEqual([
        {
          question: 'Choice 1 of 5 — what web address should the test-report viewer live at?',
          header: 'Web address',
          options: [
            {
              label: 'reports.example.dev (Recommended)',
              description: 'A clean address on a domain you already have in Cloudflare.',
            },
            { label: 'tests.example.dev', description: 'Same idea, different word.' },
            { label: '…example.workers.dev', description: "Cloudflare's free built-in address. No setup, but long." },
          ],
        },
      ]);
    });

    it('should resolve the question from the transcript once the form is answered', () => {
      // Arrange — the call and its answer landed together.
      const after = [...events('claude-2.1.281-open.jsonl'), ...events('claude-2.1.281-answered.jsonl')];

      // Act
      const projection = projectStructuredQuestion(withAskedQuestion(after, asked()));

      // Assert — the transcript took over; the hook's record holds nothing open.
      should(projection).deepEqual({ kind: 'resolved', toolUseId: TOOL_USE_ID });
    });
  });

  describe('withAskedQuestion', () => {
    it('should retire the record once anything newer than it is in the transcript', () => {
      // Arrange — the call scrolled out of the tail; a later turn is all that is left.
      const later: TranscriptEvent = {
        kind: 'message',
        harness: 'claude',
        role: 'user',
        text: 'next turn',
        timestamp: '2026-10-30T04:40:00.000Z',
      };

      // Act
      const merged = withAskedQuestion([later], asked());

      // Assert — a stale record can never bring back a form that is gone.
      should(merged).deepEqual([later]);
    });

    it('should leave a transcript that already has the call to the transcript', () => {
      // Arrange — a version that writes the call as it is asked (2.1.220).
      const answered = events('claude-2.1.281-answered.jsonl');
      const call = answered.filter(event => event.kind === 'tool-call');

      // Act / Assert
      should(withAskedQuestion(call, asked())).equal(call);
    });

    it('should pass the tail through untouched when no question was recorded', () => {
      // Arrange
      const open = events('claude-2.1.281-open.jsonl');

      // Act / Assert
      should(withAskedQuestion(open, undefined)).equal(open);
    });

    it('should not be retired by an event that carries no time', () => {
      // Arrange
      const untimed: TranscriptEvent = { kind: 'message', harness: 'claude', role: 'assistant', text: 'x' };

      // Act
      const merged = withAskedQuestion([untimed], asked());

      // Assert
      should(merged.length).equal(2);
      should(merged[1]).containDeep({ kind: 'tool-call', call: { id: TOOL_USE_ID, name: 'AskUserQuestion' } });
    });
  });

  describe('parseAskedQuestion', () => {
    it('should read the live payload for its own transcript', () => {
      // Act
      const parsed = asked();

      // Assert
      should(parsed.toolUseId).equal(TOOL_USE_ID);
      should(parsed.askedAtMs).equal(HOOK_AT);
      should(parsed.questions.length).equal(1);
      should(parsed.input).have.property('questions');
    });

    it('should refuse a payload about another conversation, or with no transcript to bind it to', () => {
      // Act / Assert — a subagent's own file, another session, or a session whose transcript is unproved.
      should(
        parseAskedQuestion(PAYLOAD, HOOK_AT, '/home/user/.claude/projects/-work-repro/other.jsonl'),
      ).be.undefined();
      should(parseAskedQuestion(PAYLOAD, HOOK_AT, undefined)).be.undefined();
    });

    it('should refuse anything that is not a whole AskUserQuestion call before it runs', () => {
      // Arrange
      const refused = [
        'not json',
        '[]',
        payloadWith({ hook_event_name: 'PostToolUse' }),
        payloadWith({ tool_name: 'Bash' }),
        payloadWith({ tool_use_id: '' }),
        payloadWith({ tool_use_id: 7 }),
        payloadWith({ tool_input: { questions: [] } }),
        payloadWith({ tool_input: { questions: [{ question: 'Ship?', options: [{ description: 'no label' }] }] } }),
        payloadWith({ tool_input: 'questions' }),
      ];

      // Act / Assert — half a question is never offered: the session falls back to the transcript.
      for (const text of refused) should(parseAskedQuestion(text, HOOK_AT, TRANSCRIPT)).be.undefined();
      should(parseAskedQuestion(PAYLOAD, Number.NaN, TRANSCRIPT)).be.undefined();
    });
  });
});
