import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AnalyticsTranscriptEvidence,
  foldAnalyticsSessionActivity,
} from '../../../src/lib/analytics/usage-fold.ts';
import {
  ClaudeTranscriptParser,
  CodexTranscriptParser,
  parseTranscriptJsonl,
} from '../../../src/lib/transcript/index.ts';
import type { TranscriptEvent } from '../../../src/lib/transcript/types.ts';

const jsonl = (records: readonly object[]): string => `${records.map(record => JSON.stringify(record)).join('\n')}\n`;

function claude(records: readonly object[]): AnalyticsTranscriptEvidence {
  const parsed = parseTranscriptJsonl(new ClaudeTranscriptParser(), { text: jsonl(records) });
  return {
    kind: 'read',
    harness: 'claude',
    events: parsed.events,
    issues: parsed.issues.map(issue => issue.code),
    pendingBytes: 0,
  };
}

function codex(records: readonly object[]): AnalyticsTranscriptEvidence {
  const parsed = parseTranscriptJsonl(new CodexTranscriptParser(), { text: jsonl(records) });
  return {
    kind: 'read',
    harness: 'codex',
    events: parsed.events,
    issues: parsed.issues.map(issue => issue.code),
    pendingBytes: 0,
  };
}

const at = (time: string) => `2026-10-20T${time}.000Z`;

/** A Claude Code session: a prompt, a tool round trip, an hour's idle wait, a second prompt. */
const CLAUDE_SESSION = [
  { type: 'user', uuid: 'u1', timestamp: at('10:00:00'), message: { role: 'user', content: 'Fix the flaky test' } },
  {
    type: 'assistant',
    uuid: 'a1',
    timestamp: at('10:00:05'),
    message: {
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'bun test' } }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  },
  // A tool result rides the user channel and is NOT a prompt.
  {
    type: 'user',
    uuid: 'u2',
    timestamp: at('10:00:40'),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '1 fail' }] },
  },
  // Nor is a record the harness wrote there itself.
  {
    type: 'user',
    uuid: 'u3',
    isMeta: true,
    timestamp: at('10:01:00'),
    message: { role: 'user', content: 'Background command finished' },
  },
  {
    type: 'assistant',
    uuid: 'a2',
    timestamp: at('10:02:00'),
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Fixed.' }] },
  },
  // An hour later — the wait is not active time.
  {
    type: 'user',
    uuid: 'u4',
    timestamp: at('11:02:00'),
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'Thanks.' },
        { type: 'text', text: 'Now the docs.' },
      ],
    },
  },
  {
    type: 'assistant',
    uuid: 'a3',
    timestamp: at('11:02:30'),
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }] },
  },
];

/** A Codex rollout: injected context, a prompt, a tool call, then a second prompt. */
const CODEX_SESSION = [
  { timestamp: at('09:00:00'), type: 'session_meta', payload: { id: 'rollout-1', cwd: '/work' } },
  {
    timestamp: at('09:00:00'),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<user_instructions>\nBe terse.\n</user_instructions>' }],
    },
  },
  {
    timestamp: at('09:00:01'),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/work</cwd>\n</environment_context>' }],
    },
  },
  { timestamp: at('09:00:10'), type: 'turn_context', payload: { model: 'gpt-6-astra', cwd: '/work' } },
  {
    timestamp: at('09:00:10'),
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List the files' }] },
  },
  { timestamp: at('09:00:10'), type: 'event_msg', payload: { type: 'user_message', message: 'List the files' } },
  {
    timestamp: at('09:00:15'),
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'call_1' },
  },
  {
    timestamp: at('09:00:16'),
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'call_1', output: 'a.ts' },
  },
  {
    timestamp: at('09:00:20'),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2, total_tokens: 7 } },
    },
  },
  {
    timestamp: at('09:00:25'),
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a.ts' }] },
  },
  {
    timestamp: at('09:30:00'),
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Thanks' }] },
  },
  {
    timestamp: at('09:30:04'),
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Welcome' }] },
  },
];

describe('analytics session activity fold', () => {
  it('should time a Claude session turn by turn, leaving out the wait between turns', () => {
    // Act
    const actual = foldAnalyticsSessionActivity(claude(CLAUDE_SESSION));

    // Assert — 10:00:00→10:02:00 is 120 s, 11:02:00→11:02:30 is 30 s; the hour between is idle
    should(actual).deepEqual({ activeDurationMs: 150_000, turns: 2 });
  });

  it('should time a Codex rollout, skipping the context Codex injects as user messages', () => {
    // Act
    const actual = foldAnalyticsSessionActivity(codex(CODEX_SESSION));

    // Assert — 09:00:10→09:00:25 is 15 s, 09:30:00→09:30:04 is 4 s
    should(actual).deepEqual({ activeDurationMs: 19_000, turns: 2 });
  });

  it('should state nothing for a transcript that shows no prompt at all', () => {
    // Act
    const actual = foldAnalyticsSessionActivity(claude([CLAUDE_SESSION[1]!]));

    // Assert
    should(actual).deepEqual({ activeDurationMs: null, turns: null });
  });

  it('should refuse active time when a prompt carries no readable timestamp, and still count turns', () => {
    // Arrange
    const untimed = [{ ...CLAUDE_SESSION[0]!, timestamp: 'not an instant' }, ...CLAUDE_SESSION.slice(1)];

    // Act
    const actual = foldAnalyticsSessionActivity(claude(untimed));

    // Assert
    should(actual).deepEqual({ activeDurationMs: null, turns: 2 });
  });

  it('should never count a turn backwards when its records are out of order', () => {
    // Arrange — a record stamped before its own prompt
    const events: TranscriptEvent[] = [
      { harness: 'claude', role: 'user', kind: 'message', text: 'go', timestamp: at('10:00:10') },
      { harness: 'claude', role: 'assistant', kind: 'message', text: 'early', timestamp: at('10:00:00') },
      { harness: 'claude', role: 'assistant', kind: 'message', text: 'untimed' },
    ];

    // Act
    const actual = foldAnalyticsSessionActivity({
      kind: 'read',
      harness: 'claude',
      events,
      issues: [],
      pendingBytes: 0,
    });

    // Assert
    should(actual).deepEqual({ activeDurationMs: 0, turns: 1 });
  });

  it.each([
    { name: 'an unresolved transcript', evidence: { kind: 'unresolved' } as const },
    { name: 'an unreadable transcript', evidence: { kind: 'unreadable' } as const },
    {
      name: 'a damaged transcript',
      evidence: { kind: 'read', harness: 'claude', events: [], issues: ['invalid-json'], pendingBytes: 0 } as const,
    },
    {
      name: 'a transcript read mid-record',
      evidence: { kind: 'read', harness: 'claude', events: [], issues: [], pendingBytes: 12 } as const,
    },
  ])('should state nothing for $name', ({ evidence }) => {
    // Act
    const actual = foldAnalyticsSessionActivity(evidence);

    // Assert
    should(actual).deepEqual({ activeDurationMs: null, turns: null });
  });
});
